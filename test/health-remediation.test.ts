import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { moveToExtensionTrash } from "../src/extensions/trash.js";
import { showHealth } from "../src/ui/health.js";
import { markReloadRequired, readReloadState } from "../src/utils/reload-state.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

interface OwnerSpec {
  name: string;
  source: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
  path?: string;
}

function stubRuntime(pi: unknown, owners: OwnerSpec[]): void {
  (pi as { getCommands: () => unknown[] }).getCommands = () =>
    owners.map((owner) => ({
      name: owner.name,
      source: "extension",
      sourceInfo: {
        source: owner.source,
        scope: owner.scope ?? "user",
        origin: owner.origin ?? "package",
        path: owner.path ?? "/nowhere",
      },
    }));
  (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
}

async function withEnv<T>(run: (dirs: { cacheDir: string; agentDir: string }) => Promise<T>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-health-cache-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extmgr-health-agent-"));
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run({ cacheDir, agentDir });
  } finally {
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

void test("health conflict remediation removes a conflicting package on request", async () => {
  await withEnv(async () => {
    const removed: Array<{ source: string; scope: string }> = [];
    const restoreCatalog = mockPackageCatalog({
      packages: [
        { source: "npm:conflict-a", name: "conflict-a", scope: "global" },
        { source: "npm:conflict-b", name: "conflict-b", scope: "global" },
      ],
      removeImpl: (source, scope) => {
        removed.push({ source, scope });
      },
    });

    try {
      const { pi, ctx } = createMockHarness({ hasUI: true, confirmResult: true });
      stubRuntime(pi, [
        { name: "demo", source: "npm:conflict-a" },
        { name: "demo", source: "npm:conflict-b" },
      ]);

      const selections = [
        "command demo", // pick the conflict
        "Remove package conflict-a (global)", // remediation
        "Global", // removal scope prompt fallback (harness returns select strings)
      ];
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = (_title, options) => {
        const next = selections.shift();
        if (next && options?.includes(next)) return Promise.resolve(next);
        return Promise.resolve(next && options ? options.find((o) => o === next) : next);
      };
      (ctx.ui as unknown as { confirm: (title: string) => Promise<boolean> }).confirm = (title) =>
        Promise.resolve(title !== "Reload Required");

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.(healthCalls === 1 ? "c" : "\u001b");
          return completion;
        });

      await showHealth(ctx, pi);

      assert.deepEqual(removed, [{ source: "npm:conflict-a", scope: "global" }]);
    } finally {
      restoreCatalog();
    }
  });
});

void test("health conflict remediation moves a package between scopes", async () => {
  await withEnv(async ({ agentDir }) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-health-move-"));
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:conflict-a"] }),
      "utf8"
    );
    const restoreCatalog = mockPackageCatalog({
      packages: [
        { source: "npm:conflict-a", name: "conflict-a", scope: "global" },
        { source: "npm:conflict-b", name: "conflict-b", scope: "global" },
      ],
    });

    try {
      const { pi, ctx } = createMockHarness({ cwd, hasUI: true, projectTrusted: true });
      stubRuntime(pi, [
        { name: "demo", source: "npm:conflict-a" },
        { name: "demo", source: "npm:conflict-b" },
      ]);

      const selections = ["command demo", "Move conflict-a to project"];
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = () => Promise.resolve(selections.shift());
      (ctx.ui as unknown as { confirm: (title: string) => Promise<boolean> }).confirm = (title) =>
        Promise.resolve(title === "Move conflicting package");

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.(healthCalls === 1 ? "c" : "\u001b");
          return completion;
        });

      await showHealth(ctx, pi);

      const globalSettings = JSON.parse(
        await readFile(join(agentDir, "settings.json"), "utf8")
      ) as { packages?: unknown[] };
      const projectSettings = JSON.parse(
        await readFile(join(cwd, ".pi", "settings.json"), "utf8")
      ) as { packages?: unknown[] };
      assert.deepEqual(globalSettings.packages, []);
      assert.deepEqual(projectSettings.packages, ["npm:conflict-a"]);
    } finally {
      restoreCatalog();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("health conflict remediation disables a conflicting local extension", async () => {
  await withEnv(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-health-disable-"));
    const extensionsRoot = join(cwd, ".pi", "extensions");
    await mkdir(extensionsRoot, { recursive: true });
    const extensionPath = join(extensionsRoot, "conflicting.ts");
    await writeFile(extensionPath, "// conflicting\n", "utf8");
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:owner-pkg", name: "owner-pkg", scope: "global" }],
    });

    try {
      const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
      stubRuntime(pi, [
        { name: "demo", source: "npm:owner-pkg" },
        { name: "demo", source: extensionPath, origin: "top-level", path: extensionPath },
      ]);

      const selections = ["command demo", "Disable local .pi/extensions/conflicting.ts"];
      (
        ctx.ui as unknown as {
          select: (title: string, options?: string[]) => Promise<string | undefined>;
        }
      ).select = () => Promise.resolve(selections.shift());
      (ctx.ui as unknown as { confirm: (title: string) => Promise<boolean> }).confirm = (title) =>
        Promise.resolve(title === "Disable conflicting extension");

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.(healthCalls === 1 ? "c" : "\u001b");
          return completion;
        });

      await showHealth(ctx, pi);

      const { access } = await import("node:fs/promises");
      await access(`${extensionPath}.disabled`);
      await assert.rejects(access(extensionPath), "active file should have been renamed");
    } finally {
      restoreCatalog();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("health fix-all-safe disables shadowing local extensions but never removes packages", async () => {
  await withEnv(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-health-fixsafe-"));
    const extensionsRoot = join(cwd, ".pi", "extensions");
    await mkdir(extensionsRoot, { recursive: true });
    const extensionPath = join(extensionsRoot, "shadow.ts");
    await writeFile(extensionPath, "// shadow\n", "utf8");
    const removed: string[] = [];
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:owner-pkg", name: "owner-pkg", scope: "global" }],
      removeImpl: (source) => {
        removed.push(source);
      },
    });

    try {
      const { pi, ctx, confirmPrompts } = createMockHarness({ cwd, hasUI: true });
      stubRuntime(pi, [
        { name: "demo", source: "npm:owner-pkg" },
        { name: "demo", source: extensionPath, origin: "top-level", path: extensionPath },
      ]);
      (ctx.ui as unknown as { confirm: (title: string) => Promise<boolean> }).confirm = (title) => {
        confirmPrompts.push(title);
        return Promise.resolve(title === "Fix all safe issues");
      };

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.(healthCalls === 1 ? "f" : "\u001b");
          return completion;
        });

      await showHealth(ctx, pi);

      const { access } = await import("node:fs/promises");
      await access(`${extensionPath}.disabled`);
      assert.deepEqual(removed, [], "fix-all-safe must never remove packages");
      assert.ok(confirmPrompts.includes("Fix all safe issues"));
    } finally {
      restoreCatalog();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("health reload action ends the screen and clears the reload marker", async () => {
  await withEnv(async ({ cacheDir }) => {
    await markReloadRequired("test reload", join(cacheDir, "reload-required.json"));
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { pi, ctx, reloadCount } = createMockHarness({ hasUI: true });
      stubRuntime(pi, []);

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.("l");
          return completion;
        });

      const exit = await showHealth(ctx, pi);

      assert.equal(reloadCount(), 1);
      assert.equal(healthCalls, 1, "reload must end the health loop, not reopen it");
      assert.equal(exit, "reloaded", "callers must learn the context was reloaded");
      assert.equal((await readReloadState(join(cacheDir, "reload-required.json"))).required, false);
    } finally {
      restoreCatalog();
    }
  });
});

void test("health resolves its trash root after environment overrides", async () => {
  await withEnv(async ({ agentDir }) => {
    const source = join(agentDir, "extension.ts");
    await writeFile(source, "// extension\n", "utf8");
    await moveToExtensionTrash(source, join(agentDir, ".extmgr-trash"));
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { pi, ctx } = createMockHarness({ hasUI: true });
      stubRuntime(pi, []);
      let rendered: string[] = [];
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("command/tool entries loaded"))) {
            rendered = lines;
            component.handleInput?.("\u001b");
          }
          return completion;
        });

      await showHealth(ctx, pi);

      assert.ok(rendered.some((line) => line.includes("1 recoverable extension")));
    } finally {
      restoreCatalog();
    }
  });
});

void test("health trash action lists trash and offers restore/purge choices", async () => {
  await withEnv(async () => {
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { pi, ctx, notifications, selectPrompts } = createMockHarness({ hasUI: true });
      stubRuntime(pi, []);

      let healthCalls = 0;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (!lines.some((line) => line.includes("command/tool entries loaded"))) {
            return completion;
          }
          healthCalls += 1;
          component.handleInput?.(healthCalls === 1 ? "t" : "\u001b");
          return completion;
        });

      await showHealth(ctx, pi);

      // Empty trash: the list command reports nothing to manage; no submenu.
      assert.ok(
        notifications.some((entry) => entry.message.toLowerCase().includes("no trash")),
        `expected an empty-trash notification, got: ${JSON.stringify(notifications)}`
      );
      assert.ok(!selectPrompts.includes("Trash actions"));
    } finally {
      restoreCatalog();
    }
  });
});

void test("health screen keeps every line within narrow terminal widths", async () => {
  await withEnv(async () => {
    const restoreCatalog = mockPackageCatalog({
      packages: [
        {
          source: "npm:a-package-with-a-particularly-long-name",
          name: "a-package-with-a-particularly-long-name",
          scope: "global",
        },
      ],
    });
    try {
      const { pi, ctx } = createMockHarness({ hasUI: true });
      stubRuntime(pi, [
        { name: "demo", source: "npm:a-package-with-a-particularly-long-name" },
        { name: "demo", source: "npm:another-competing-package-name" },
      ]);

      const { visibleWidth } = await import("@earendil-works/pi-tui");
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(
          factory,
          ctx.ui.theme,
          (component, lines, completion) => {
            if (!lines.some((line) => line.includes("Health"))) return completion;
            assert.ok(
              lines.every((line) => visibleWidth(line) <= 30),
              "health lines must stay within a 30-column terminal"
            );
            component.handleInput?.("\u001b");
            return completion;
          },
          { width: 30, height: 40 }
        );

      await showHealth(ctx, pi);
    } finally {
      restoreCatalog();
    }
  });
});
