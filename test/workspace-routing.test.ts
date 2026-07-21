import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { clearSearchCache, setSearchCache } from "../src/packages/discovery.js";
import { browseRemotePackages } from "../src/ui/remote.js";
import { showInteractive } from "../src/ui/unified.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";

initTheme();

const TAB = "\t";
const SHIFT_TAB = "\u001b[Z";

async function withCacheDir<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previous;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

void test("Shift+Tab routes Installed through Health to Profiles", async () => {
  await withCacheDir("pi-extmgr-route-f3-", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-route-installed-"));
    try {
      const extensionsRoot = join(cwd, ".pi", "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(join(extensionsRoot, "route-demo.ts"), "// demo\n", "utf8");

      const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
      (pi as { getCommands: () => unknown[] }).getCommands = () => [];
      (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
      const screens: string[] = [];

      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Loading"))) return completion;
          if (lines.some((line) => line.includes("Save current package set"))) {
            screens.push("profiles");
            component.handleInput?.("\u001b");
            return completion;
          }
          if (lines.some((line) => line.includes("command/tool entries loaded"))) {
            screens.push("health");
            component.handleInput?.(SHIFT_TAB);
            return completion;
          }
          screens.push("installed");
          if (screens.filter((screen) => screen === "installed").length === 1) {
            component.handleInput?.(SHIFT_TAB);
            return completion;
          }
          return { type: "cancel" };
        });

      await showInteractive(ctx, pi);

      assert.deepEqual(screens, ["installed", "health", "profiles", "installed"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("Shift+Tab routes Installed to Health and back restores Installed", async () => {
  await withCacheDir("pi-extmgr-route-f4-", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-route-health-"));
    try {
      const extensionsRoot = join(cwd, ".pi", "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(join(extensionsRoot, "route-health.ts"), "// demo\n", "utf8");

      const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
      (pi as { getCommands: () => unknown[] }).getCommands = () => [];
      (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
      const screens: string[] = [];

      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Loading"))) return completion;
          if (lines.some((line) => line.includes("command/tool entries loaded"))) {
            screens.push("health");
            component.handleInput?.("\u001b");
            return completion;
          }
          screens.push("installed");
          if (screens.filter((screen) => screen === "installed").length === 1) {
            component.handleInput?.(SHIFT_TAB);
            return completion;
          }
          return { type: "cancel" };
        });

      await showInteractive(ctx, pi);

      assert.deepEqual(screens, ["installed", "health", "installed"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("Tab routes Discover to Profiles and resumes browsing afterwards", async () => {
  await withCacheDir("pi-extmgr-route-discover-", async () => {
    setSearchCache({
      query: "route-demo",
      results: [{ name: "route-pkg", version: "1.0.0", description: "Routing demo" }],
      total: 1,
      offset: 0,
      timestamp: Date.now(),
    });

    const { pi, ctx } = createMockHarness({ hasUI: true });
    const screens: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
      captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
        if (lines.some((line) => line.includes("Save current package set"))) {
          screens.push("profiles");
          component.handleInput?.("\u001b");
          return completion;
        }
        screens.push("discover");
        if (screens.filter((screen) => screen === "discover").length === 1) {
          component.handleInput?.(TAB);
          return completion;
        }
        return { type: "cancel" };
      });

    try {
      await browseRemotePackages(ctx, "route-demo", pi);
      assert.deepEqual(screens, ["discover", "profiles", "discover"]);
    } finally {
      clearSearchCache();
    }
  });
});

void test("Tab routes Profiles to Health without dropping back to the caller", async () => {
  await withCacheDir("pi-extmgr-route-aux-", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-route-aux-cwd-"));
    try {
      const extensionsRoot = join(cwd, ".pi", "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(join(extensionsRoot, "route-aux.ts"), "// demo\n", "utf8");

      const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
      (pi as { getCommands: () => unknown[] }).getCommands = () => [];
      (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
      const screens: string[] = [];

      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Loading"))) return completion;
          if (lines.some((line) => line.includes("Save current package set"))) {
            screens.push("profiles");
            component.handleInput?.(TAB);
            return completion;
          }
          if (lines.some((line) => line.includes("command/tool entries loaded"))) {
            screens.push("health");
            if (screens.filter((screen) => screen === "health").length === 1) {
              component.handleInput?.(SHIFT_TAB);
            } else {
              component.handleInput?.("\u001b");
            }
            return completion;
          }
          screens.push("installed");
          if (screens.filter((screen) => screen === "installed").length === 1) {
            component.handleInput?.(SHIFT_TAB);
            return completion;
          }
          return { type: "cancel" };
        });

      await showInteractive(ctx, pi);

      assert.deepEqual(screens, ["installed", "health", "profiles", "health", "installed"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("Tab navigation works during search while ordinary characters stay typeable", async () => {
  const { UnifiedManagerBrowser } = await import("../src/ui/installed/browser.js");
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keybindings = {
    matches: (data: string, binding: string): boolean => {
      if (binding === "tui.select.confirm") return data === "\r";
      if (binding === "tui.select.cancel") return data === "\u001b";
      return false;
    },
    getKeys: () => [],
  };
  const actions: unknown[] = [];
  const browser = new UnifiedManagerBrowser(
    [
      {
        type: "local",
        id: "project:/tmp/demo.ts",
        displayName: "demo.ts",
        summary: "demo",
        scope: "project",
        state: "enabled",
        activePath: "/tmp/demo.ts",
        disabledPath: "/tmp/demo.ts.disabled",
        originalState: "enabled",
      },
    ],
    new Map(),
    theme as never,
    keybindings as never,
    "/tmp",
    10,
    (action) => actions.push(action)
  );

  browser.handleManagerInput("/");
  browser.handleManagerInput("[");
  browser.handleManagerInput("]");
  assert.equal(browser.getSearchQuery(), "[]", "ordinary characters must reach the search input");
  assert.deepEqual(actions, []);

  // Workspace navigation is global and remains predictable while search is focused.
  browser.handleManagerInput(TAB);
  browser.handleManagerInput(SHIFT_TAB);
  assert.deepEqual(actions, [
    { type: "workspace", screen: "discover" },
    { type: "workspace", screen: "health" },
  ]);
});

void test("Tab wraps Health back to Installed", async () => {
  await withCacheDir("pi-extmgr-route-cycle-health-", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-route-cycle-health-cwd-"));
    try {
      const extensionsRoot = join(cwd, ".pi", "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(join(extensionsRoot, "cycle-health.ts"), "// demo\n", "utf8");

      const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
      (pi as { getCommands: () => unknown[] }).getCommands = () => [];
      (pi as { getAllTools: () => unknown[] }).getAllTools = () => [];
      const screens: string[] = [];

      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
          if (lines.some((line) => line.includes("Loading"))) return completion;
          if (lines.some((line) => line.includes("command/tool entries loaded"))) {
            screens.push("health");
            component.handleInput?.(TAB);
            return completion;
          }
          screens.push("installed");
          if (screens.filter((screen) => screen === "installed").length === 1) {
            component.handleInput?.(SHIFT_TAB);
            return completion;
          }
          return { type: "cancel" };
        });

      await showInteractive(ctx, pi);

      assert.deepEqual(screens, ["installed", "health", "installed"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

void test("Tab navigation from Installed preserves the staged-change guard", async () => {
  await withCacheDir("pi-extmgr-route-guard-", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-route-guard-cwd-"));
    try {
      const extensionsRoot = join(cwd, ".pi", "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(join(extensionsRoot, "guard-demo.ts"), "// demo\n", "utf8");

      const { pi, ctx, selectPrompts } = createMockHarness({ cwd, hasUI: true });
      const queuedSelections = ["Stay in manager", "Exit without saving"];
      (
        ctx.ui as { select: (title: string, options?: string[]) => Promise<string | undefined> }
      ).select = (title) => {
        selectPrompts.push(title);
        return Promise.resolve(queuedSelections.shift());
      };

      let managerCalls = 0;
      let resumedLines: string[] = [];
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
        captureCustomComponent(
          factory,
          ctx.ui.theme,
          (lines) => lines.some((line) => line.includes("/ Search")),
          (component, lines, completion) => {
            managerCalls += 1;
            if (managerCalls === 1) {
              component.handleInput?.(" "); // stage a toggle
              component.handleInput?.(TAB); // try to leave for Discover
              return completion;
            }
            resumedLines = lines;
            return { type: "cancel" };
          }
        );

      await showInteractive(ctx, pi);

      assert.equal(
        selectPrompts.filter((title) => title === "Unsaved changes (1)").length,
        2,
        "Tab with staged changes must prompt, and staying must keep the pending change"
      );
      assert.ok(
        resumedLines.some((line) => line.includes("guard-demo.ts")),
        "manager should resume with the staged item visible after choosing to stay"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
