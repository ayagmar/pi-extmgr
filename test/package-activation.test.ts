import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyPackageStateChange } from "../src/packages/activation.js";
import { getPackageCatalog } from "../src/packages/catalog.js";
import { applyPackageExtensionStateChanges } from "../src/packages/extensions.js";
import { movePackageBetweenScopes } from "../src/packages/scopes.js";
import { applyProfileWithOutcome } from "../src/profiles/execute.js";
import { getCurrentProfile } from "../src/profiles/runtime-state.js";
import { parseExternalProfile } from "../src/profiles/schema.js";
import { readProfileStore, saveNamedProfile } from "../src/profiles/store.js";
import { handleBulkAction } from "../src/ui/installed/bulk.js";
import { matchesUnifiedFilter } from "../src/ui/installed/filters.js";
import { formatPackageState } from "../src/ui/installed/formatting.js";
import { handlePackageItemAction } from "../src/ui/installed/item-actions.js";
import { buildUnifiedItems } from "../src/ui/installed/items.js";
import { createMockHarness } from "./helpers/mocks.js";

async function fixture(
  run: (f: { cwd: string; agentDir: string; global: string; project: string }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "extmgr-activation-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await run({
      cwd,
      agentDir,
      global: join(agentDir, "settings.json"),
      project: join(cwd, ".pi", "settings.json"),
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
async function save(path: string, packages: unknown[]) {
  await writeFile(path, JSON.stringify({ packages, unrelated: "preserved" }));
}
async function entries(path: string) {
  return (
    JSON.parse(await readFile(path, "utf8")) as {
      packages: Array<string | Record<string, unknown>>;
    }
  ).packages;
}

void test("whole-package disable is reversible and idempotent for strings and filtered objects", async () => {
  await fixture(async ({ cwd, global, project }) => {
    const originals = [
      "npm:demo",
      {
        source: "npm:demo",
        extensions: ["-extensions/a.ts"],
        skills: [],
        prompts: ["*.md", "!old.md", "+keep.md"],
        autoload: false,
        custom: { keep: true },
      },
    ];
    for (const original of originals) {
      await save(global, [original, "npm:other"]);
      await save(project, ["npm:project-only"]);
      assert.deepEqual(await applyPackageStateChange("npm:demo", "global", "disabled", cwd, true), {
        ok: true,
        changed: true,
      });
      const disabled = (await entries(global))[0];
      assert.equal(typeof disabled, "object");
      if (typeof disabled !== "object" || !disabled) throw new Error("missing disabled entry");
      for (const key of ["extensions", "skills", "prompts", "themes"])
        assert.deepEqual(disabled[key], []);
      assert.equal(disabled.autoload, true);
      const bytes = await readFile(global, "utf8");
      assert.deepEqual(await applyPackageStateChange("npm:demo", "global", "disabled", cwd, true), {
        ok: true,
        changed: false,
      });
      assert.equal(await readFile(global, "utf8"), bytes);
      assert.deepEqual(await entries(project), ["npm:project-only"]);
      assert.deepEqual(await applyPackageStateChange("npm:demo", "global", "enabled", cwd, true), {
        ok: true,
        changed: true,
      });
      assert.deepEqual(await entries(global), [original, "npm:other"]);
      assert.deepEqual(await applyPackageStateChange("npm:demo", "global", "enabled", cwd, true), {
        ok: true,
        changed: false,
      });
    }
  });
});

void test("restore retains source updates and unrelated edits and survives a scope move", async () => {
  await fixture(async ({ cwd, global, project }) => {
    await save(global, ["npm:demo@1.0.0"]);
    await applyPackageStateChange("npm:demo@1.0.0", "global", "disabled", cwd);
    const disabled = (await entries(global))[0];
    assert.equal(typeof disabled, "object");
    await save(global, [
      { ...(disabled as Record<string, unknown>), source: "npm:demo@2.0.0", added: true },
    ]);
    assert.equal(
      (await movePackageBetweenScopes("npm:demo@2.0.0", "global", "project", cwd, true)).moved,
      true
    );
    assert.deepEqual(
      await applyPackageStateChange("npm:demo@2.0.0", "project", "enabled", cwd, true),
      { ok: true, changed: true }
    );
    assert.deepEqual(await entries(project), [{ source: "npm:demo@2.0.0", added: true }]);
  });
});

void test("conflicting edits and invalid disable metadata fail closed without writes", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:demo"]);
    await applyPackageStateChange("npm:demo", "global", "disabled", cwd);
    const disabled = (await entries(global))[0] as Record<string, unknown>;
    const broken = [
      { ...disabled, skills: ["+skills/a"] },
      { ...disabled, autoload: false },
      { ...disabled, piExtmgrDisabled: null },
      { ...disabled, piExtmgrDisabled: { version: 2 } },
      {
        ...disabled,
        piExtmgrDisabled: { version: 1, originalForm: "string", fields: { skills: [42] } },
      },
    ];
    for (const entry of broken) {
      await save(global, [entry]);
      const before = await readFile(global, "utf8");
      for (const target of ["enabled", "disabled"] as const) {
        const result = await applyPackageStateChange("npm:demo", "global", target, cwd);
        assert.equal(result.ok, false);
        assert.equal(await readFile(global, "utf8"), before);
      }
    }
  });
});

void test("enabling without a snapshot preserves manually configured filters", async () => {
  await fixture(async ({ cwd, global }) => {
    const entry = { source: "npm:demo", extensions: [], skills: [], prompts: [], themes: [] };
    await save(global, [entry]);
    const result = await applyPackageStateChange("npm:demo", "global", "enabled", cwd);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.changed, false);
      assert.match(result.message ?? "", /no saved configuration/i);
    }
    assert.deepEqual(await entries(global), [entry]);
  });
});

void test("missing, ambiguous, malformed and untrusted settings cannot be mutated", async () => {
  await fixture(async ({ cwd, global, project }) => {
    await save(global, ["npm:demo@1", "npm:demo@2"]);
    assert.equal((await applyPackageStateChange("npm:demo", "global", "disabled", cwd)).ok, false);
    assert.equal(
      (await applyPackageStateChange("npm:missing", "global", "disabled", cwd)).ok,
      false
    );
    await save(project, ["./missing-skill-only-package"]);
    const before = await readFile(project, "utf8");
    assert.equal(
      (await applyPackageStateChange("./missing-skill-only-package", "project", "disabled", cwd))
        .ok,
      false
    );
    assert.equal(await readFile(project, "utf8"), before);
    assert.equal(
      (
        await applyPackageStateChange(
          join(cwd, ".pi", "missing-skill-only-package"),
          "project",
          "disabled",
          cwd,
          true
        )
      ).ok,
      true
    );
    await writeFile(global, "{invalid");
    assert.equal((await applyPackageStateChange("npm:demo", "global", "disabled", cwd)).ok, false);
    assert.equal(await readFile(global, "utf8"), "{invalid");
  });
});

void test("extension-only writers cannot partially reactivate a disabled package", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:demo"]);
    await applyPackageStateChange("npm:demo", "global", "disabled", cwd);
    const before = await readFile(global, "utf8");
    const result = await applyPackageExtensionStateChanges(
      "npm:demo",
      "global",
      [{ extensionPath: "extensions/a.ts", target: "enabled" }],
      cwd
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /enable the package first/i);
    assert.equal(await readFile(global, "utf8"), before);
  });
});

void test("extension-only writes through equivalent local sources cannot bypass package suspension", async () => {
  await fixture(async ({ cwd, global, agentDir }) => {
    await save(global, ["./local-package"]);
    await applyPackageStateChange("./local-package", "global", "disabled", cwd);
    const before = await readFile(global, "utf8");
    const result = await applyPackageExtensionStateChanges(
      join(agentDir, "local-package"),
      "global",
      [{ extensionPath: "extensions/a.ts", target: "enabled" }],
      cwd
    );
    assert.equal(result.ok, false);
    assert.equal(await readFile(global, "utf8"), before);
  });
});

void test("single-package actions toggle skill-only packages and request reload only on changes", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:skills-only"]);
    const harness = createMockHarness({ cwd, hasUI: true });
    const item = {
      type: "package" as const,
      id: "pkg:npm:skills-only",
      displayName: "skills-only",
      source: "npm:skills-only",
      scope: "global" as const,
    };
    const guard = async () => "continue" as const;
    await handlePackageItemAction(item, "disable", harness.ctx, harness.pi, guard);
    assert.deepEqual(((await entries(global))[0] as Record<string, unknown>).skills, []);
    assert.equal(harness.confirmPrompts.filter((p) => p === "Reload Required").length, 1);
    await handlePackageItemAction(item, "disable", harness.ctx, harness.pi, guard);
    assert.equal(harness.confirmPrompts.filter((p) => p === "Reload Required").length, 1);
    await handlePackageItemAction(item, "enable", harness.ctx, harness.pi, guard);
    assert.deepEqual(await entries(global), ["npm:skills-only"]);
    assert.ok(harness.notifications.some((n) => /fresh session/i.test(n.message)));
  });
});

void test("bulk toggles report changed, no-op and failed packages independently", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:one", "npm:two"]);
    await applyPackageStateChange("npm:two", "global", "disabled", cwd);
    const harness = createMockHarness({
      cwd,
      hasUI: true,
      hasCustomUI: false,
      confirmImpl: (title) => title !== "Reload Required",
    });
    const items = ["one", "two", "missing"].map((name) => ({
      type: "package" as const,
      id: name,
      displayName: name,
      source: `npm:${name}`,
      scope: "global" as const,
    }));
    await handleBulkAction(
      items.map((item) => item.id),
      "disable",
      new Map(items.map((item) => [item.id, item])),
      harness.ctx,
      harness.pi
    );
    assert.deepEqual(((await entries(global))[0] as Record<string, unknown>).skills, []);
    const report = harness.notifications.map((n) => n.message).join("\n");
    assert.match(report, /1 succeeded/);
    assert.match(report, /1 failed/);
    assert.match(report, /1 skipped/);
    assert.equal(harness.confirmPrompts.filter((p) => p === "Reload Required").length, 1);
    await handleBulkAction(
      ["one", "two"],
      "disable",
      new Map(items.map((item) => [item.id, item])),
      harness.ctx,
      harness.pi
    );
    assert.equal(harness.confirmPrompts.filter((p) => p === "Reload Required").length, 1);
  });
});

void test("disabled configuration round-trips through profile save, import and apply", async () => {
  await fixture(async ({ cwd, agentDir, global }) => {
    const root = join(agentDir, "local-package");
    await mkdir(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "local-package", version: "1.0.0" })
    );
    const original = { source: root, skills: ["-skills/optional"] };
    await save(global, [original]);
    await applyPackageStateChange(root, "global", "disabled", cwd);
    const disabled = await entries(global);
    const { ctx, pi } = createMockHarness({
      cwd,
      hasUI: true,
      hasCustomUI: false,
      confirmImpl: (title) => title === "Apply profile",
    });
    const profile = await getCurrentProfile(ctx, pi);
    const store = join(agentDir, "test-profiles.json");
    await saveNamedProfile(store, { ...profile, name: "disabled" });
    const exported = JSON.stringify((await readProfileStore(store)).profiles.disabled);
    const parsed = parseExternalProfile(JSON.parse(exported));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("profile import rejected");
    await applyPackageStateChange(root, "global", "enabled", cwd);
    const current = await getCurrentProfile(ctx, pi);
    const outcome = await applyProfileWithOutcome(current, parsed.profile, ctx, pi);
    assert.equal(outcome.applied, true, JSON.stringify(outcome));
    assert.deepEqual(await entries(global), disabled);
    await applyPackageStateChange(root, "global", "enabled", cwd);
    assert.deepEqual(await entries(global), [original]);
  });
});

void test("package update retains activation metadata and removal/reinstall does not resurrect it", async () => {
  await fixture(async ({ cwd, agentDir, global }) => {
    const root = join(agentDir, "local-package");
    await mkdir(root);
    await save(global, [root]);
    await applyPackageStateChange(root, "global", "disabled", cwd);
    const before = await entries(global);
    const catalog = getPackageCatalog(cwd);
    await catalog.update(root);
    assert.deepEqual(await entries(global), before);
    await catalog.remove(root, "global");
    assert.deepEqual(await entries(global), []);
    await catalog.install(root, "global");
    // Pi normalizes local sources relative to the settings directory on install.
    assert.deepEqual(await entries(global), ["local-package"]);
  });
});

void test("settings flush failure does not report a successful toggle", async (t) => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:demo"]);
    t.mock.method(SettingsManager.prototype, "flush", async () => {
      throw new Error("flush failed");
    });
    const result = await applyPackageStateChange("npm:demo", "global", "disabled", cwd);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /flush failed/);
  });
});

for (const manifest of [false, true]) {
  void test(`Pi resolves no enabled package resources while disabled (manifest=${manifest})`, async () => {
    await fixture(async ({ cwd, agentDir, global, project }) => {
      const root = join(agentDir, "fixture-package");
      for (const [path, content] of [
        ["extensions/a.ts", "export default function () {}"],
        ["skills/a/SKILL.md", "---\nname: fixture-skill\ndescription: Fixture skill\n---\nExample"],
        ["prompts/a.md", "Example prompt"],
        ["themes/a.json", "{}"],
      ]) {
        const target = join(root, path as string);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, content as string);
      }
      if (manifest)
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            pi: {
              extensions: ["extensions/a.ts"],
              skills: ["skills"],
              prompts: ["prompts"],
              themes: ["themes"],
            },
          })
        );
      await save(global, [root]);
      const originalProject = { source: root, autoload: false, prompts: ["-prompts/a.md"] };
      await save(project, [originalProject]);
      const resolve = async () =>
        new DefaultPackageManager({
          cwd,
          agentDir,
          settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
        }).resolve();
      const before = await resolve();
      for (const kind of ["extensions", "skills", "themes"] as const)
        assert.ok(before[kind].some((r) => r.enabled));
      assert.equal(
        before.prompts.some((r) => r.enabled),
        false
      );
      assert.equal(
        (await applyPackageStateChange(root, "project", "disabled", cwd, true)).ok,
        true
      );
      const disabled = await resolve();
      for (const kind of ["extensions", "skills", "prompts", "themes"] as const)
        assert.equal(
          disabled[kind].some((r) => r.enabled),
          false,
          kind
        );
      assert.equal((await applyPackageStateChange(root, "project", "enabled", cwd, true)).ok, true);
      assert.deepEqual(await resolve(), before);
      assert.deepEqual(await entries(project), [originalProject]);
    });
  });
}

void test("enable re-enables extensions disabled by the earlier extension-only action", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, [{ source: "npm:legacy", extensions: ["-extensions/a.ts"] }]);
    const harness = createMockHarness({ cwd, hasUI: true });
    const item = {
      type: "package" as const,
      id: "pkg:npm:legacy",
      displayName: "legacy",
      source: "npm:legacy",
      scope: "global" as const,
      extensionPaths: ["extensions/a.ts"],
      extensionSummary: { enabled: 0, disabled: 1, total: 1 },
    };
    const guard = async () => "continue" as const;
    await handlePackageItemAction(item, "enable", harness.ctx, harness.pi, guard);
    assert.deepEqual(await entries(global), ["npm:legacy"]);
    assert.ok(harness.notifications.some((n) => /earlier extmgr version/.test(n.message)));
    assert.equal(harness.confirmPrompts.filter((p) => p === "Reload Required").length, 1);

    // Filters that deliberately load nothing are not a legacy disable.
    const loadNothing = {
      source: "npm:legacy",
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    await save(global, [loadNothing]);
    await handlePackageItemAction(item, "enable", harness.ctx, harness.pi, guard);
    assert.deepEqual(await entries(global), [loadNothing]);
    assert.ok(harness.notifications.some((n) => /no saved configuration/i.test(n.message)));
  });
});

void test("a snapshot conflict can be discarded from the single-package action", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, [{ source: "npm:demo", prompts: ["-prompts/old.md"] }]);
    await applyPackageStateChange("npm:demo", "global", "disabled", cwd);
    const disabled = (await entries(global))[0] as Record<string, unknown>;
    const edited: Record<string, unknown> = { ...disabled, skills: ["+skills/a"] };
    await save(global, [edited]);
    const item = {
      type: "package" as const,
      id: "pkg:npm:demo",
      displayName: "demo",
      source: "npm:demo",
      scope: "global" as const,
    };
    const guard = async () => "continue" as const;

    const declined = createMockHarness({ cwd, hasUI: true, confirmImpl: () => false });
    const before = await readFile(global, "utf8");
    await handlePackageItemAction(item, "enable", declined.ctx, declined.pi, guard);
    assert.deepEqual(declined.confirmPrompts, ["Package settings changed"]);
    assert.equal(await readFile(global, "utf8"), before);

    const accepted = createMockHarness({ cwd, hasUI: true, confirmImpl: () => true });
    await handlePackageItemAction(item, "disable", accepted.ctx, accepted.pi, guard);
    const redisabled = (await entries(global))[0] as Record<string, unknown>;
    assert.deepEqual(redisabled.skills, []);
    assert.deepEqual((redisabled.piExtmgrDisabled as { fields: unknown }).fields, {
      extensions: [],
      skills: ["+skills/a"],
      prompts: [],
      themes: [],
      autoload: true,
    });

    await save(global, [edited]);
    await handlePackageItemAction(item, "enable", accepted.ctx, accepted.pi, guard);
    const { piExtmgrDisabled: _snapshot, ...kept } = edited;
    assert.deepEqual(await entries(global), [kept]);
    assert.ok(accepted.notifications.some((n) => /current filters are kept/.test(n.message)));
  });
});

void test("the Installed list marks whole-package disables", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:demo", "npm:other"]);
    await applyPackageStateChange("npm:demo", "global", "disabled", cwd);
    const packages = await getPackageCatalog(cwd).listInstalledPackages();
    assert.deepEqual(
      packages.map((pkg) => [pkg.source, pkg.disabled ?? false]),
      [
        ["npm:demo", true],
        ["npm:other", false],
      ]
    );
    const items = buildUnifiedItems([], packages, new Set());
    const disabled = items.filter((item) =>
      matchesUnifiedFilter(item, "disabled", new Map(), new Set(), new Set())
    );
    assert.deepEqual(
      disabled.map((item) => item.id),
      ["pkg:npm:demo"]
    );
    const [demo] = disabled;
    assert.equal(demo?.type === "package" && formatPackageState(demo), "package disabled");
  });
});

void test("extension writes match a configured package by identity", async () => {
  await fixture(async ({ cwd, global }) => {
    await save(global, ["npm:demo@1.0.0"]);
    const change = [{ extensionPath: "extensions/a.ts", target: "disabled" as const }];
    assert.deepEqual(
      await applyPackageExtensionStateChanges("npm:demo@2.0.0", "global", change, cwd),
      { ok: true }
    );
    assert.deepEqual(await entries(global), [
      { source: "npm:demo@1.0.0", extensions: ["-extensions/a.ts"] },
    ]);

    await save(global, ["npm:demo@1.0.0", "npm:demo@2.0.0"]);
    const before = await readFile(global, "utf8");
    const result = await applyPackageExtensionStateChanges("npm:demo", "global", change, cwd);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /ambiguous/i);
    assert.equal(await readFile(global, "utf8"), before);
  });
});
