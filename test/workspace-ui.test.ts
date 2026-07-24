import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getProfileStorePath, readProfileStore, saveNamedProfile } from "../src/profiles/store.js";
import { showHealth } from "../src/ui/health.js";
import { showProfiles } from "../src/ui/profiles.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

void test("profiles screen keeps profile management in a dedicated workspace", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-profiles-ui-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;

  try {
    const { pi, ctx } = createMockHarness({ hasUI: true });
    let renderedLines: string[] = [];
    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
      captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
        renderedLines = lines;
        component.handleInput?.("\u001b");
        return completion;
      });

    await showProfiles(ctx, pi);

    assert.ok(renderedLines.some((line) => line.includes("Profiles")));
    assert.ok(renderedLines.some((line) => line.includes("Save current package set")));
  } finally {
    if (previousCacheDir === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

void test("profiles import shows its diagnostics summary before Save", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-import-ui-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-import-ui-cache-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  const restoreCatalog = mockPackageCatalog({ packages: [] });

  try {
    const source = join(root, "profile.json");
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 1,
        name: "team",
        packages: [{ source: "npm:demo", scope: "project" }],
      }),
      "utf8"
    );
    const { pi, ctx } = createMockHarness({ cwd: root, hasUI: true, inputResult: source });
    const events: string[] = [];
    let summaryLines: string[] = [];
    let profileListVisits = 0;
    (
      ctx.ui as unknown as {
        select: (title: string, options?: string[]) => Promise<string | undefined>;
      }
    ).select = (title) => {
      if (title === "Import profile") {
        events.push("select");
        return Promise.resolve("Save");
      }
      return Promise.resolve(undefined);
    };
    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
      captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
        if (lines.some((line) => line.includes("Save current package set"))) {
          profileListVisits += 1;
          if (profileListVisits === 1) {
            component.handleInput?.("\u001b[B");
            component.handleInput?.("\r");
          } else {
            component.handleInput?.("\u001b");
          }
          return completion;
        }
        if (lines.some((line) => line.includes("Import profile: team"))) {
          events.push("summary");
          summaryLines = lines;
        }
        component.handleInput?.("\u001b");
        return completion;
      });

    await showProfiles(ctx, pi);

    assert.deepEqual(events, ["summary", "select"]);
    assert.ok(summaryLines.some((line) => line.includes("Origin:")));
    assert.ok(summaryLines.some((line) => line.includes("Preview: 1 add")));
    assert.ok(summaryLines.some((line) => line.includes("Policy: pass")));
    assert.ok(summaryLines.some((line) => line.includes("Compatibility: 1 unknown")));
    assert.ok(summaryLines.some((line) => line.includes("Integrity: 1 unknown")));
    assert.equal((await readProfileStore(getProfileStorePath())).profiles.team?.name, "team");
  } finally {
    restoreCatalog();
    if (previousCacheDir === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    await rm(root, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

void test("profiles screen renders an inline current-versus-target diff", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-diff-ui-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  const restoreCatalog = mockPackageCatalog({ packages: [] });

  try {
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "target",
      packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
    });
    const { pi, ctx } = createMockHarness({ hasUI: true });
    (
      ctx.ui as unknown as {
        select: (title: string, options?: string[]) => Promise<string | undefined>;
      }
    ).select = (title) =>
      Promise.resolve(title.startsWith("Profile:") ? "Review and apply" : undefined);
    let diffLines: string[] = [];
    let openedReview = false;
    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
      captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
        // Route on rendered content: the profile list confirms into the
        // review once, the diff screen is captured, everything else backs out.
        if (!openedReview && lines.some((line) => line.includes("Save current package set"))) {
          openedReview = true;
          component.handleInput?.("\r");
          return completion;
        }
        if (lines.some((line) => line.includes("Target · target"))) {
          diffLines = lines;
        }
        component.handleInput?.("\u001b");
        return completion;
      });

    await showProfiles(ctx, pi);

    assert.ok(diffLines.some((line) => line.includes("Current")));
    assert.ok(diffLines.some((line) => line.includes("Target · target")));
    assert.ok(diffLines.some((line) => line.includes("+ npm:demo")));
  } finally {
    restoreCatalog();
    if (previousCacheDir === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

void test("profiles screen keeps every line within narrow terminal widths", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-profiles-narrow-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;

  try {
    await saveNamedProfile(getProfileStorePath(), {
      schemaVersion: 1,
      name: "a-profile-with-a-particularly-long-name",
      packages: [{ source: "npm:very-long-package-name-for-narrow-testing", scope: "global" }],
    });
    const { pi, ctx } = createMockHarness({ hasUI: true });
    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (component, lines, completion) => {
          assert.ok(
            lines.every((line) => visibleWidth(line) <= 30),
            "profiles lines must stay within a 30-column terminal"
          );
          component.handleInput?.("\u001b");
          return completion;
        },
        { width: 30, height: 40 }
      );

    await showProfiles(ctx, pi);
  } finally {
    if (previousCacheDir === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

void test("health screen surfaces runtime, compatibility, reload, and trash sections", async () => {
  const { pi, ctx } = createMockHarness({ hasUI: true });
  (pi as { getCommands: () => unknown[] }).getCommands = () => [];
  (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
  let renderedLines: string[] = [];
  (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
    captureCustomComponent(
      factory,
      ctx.ui.theme,
      (component, lines, completion) => {
        renderedLines = lines;
        assert.ok(lines.every((line) => visibleWidth(line) <= 120));
        component.handleInput?.("\u001b");
        return completion;
      },
      { width: 120, height: 50 }
    );

  await showHealth(ctx, pi);

  assert.ok(renderedLines.some((line) => line.includes("Health")));
  assert.ok(renderedLines.some((line) => line.includes("Runtime")));
  assert.ok(renderedLines.some((line) => line.includes("Compatibility")));
  assert.ok(renderedLines.some((line) => line.includes("Reload")));
  assert.ok(renderedLines.some((line) => line.includes("Trash")));
});
