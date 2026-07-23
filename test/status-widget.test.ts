import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { restorePiTitle, setWorkspaceTitle } from "../src/ui/workspace/title.js";
import { clearReloadRequired, markReloadRequired } from "../src/utils/reload-state.js";
import { updateExtmgrStatus } from "../src/utils/status.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

async function withIsolatedState<T>(run: () => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-status-widget-"));
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  try {
    return await run();
  } finally {
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

void test("attention widget appears while a reload is pending and clears afterwards", async () => {
  await withIsolatedState(async () => {
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { pi, ctx, widgets } = createMockHarness({ hasUI: true });

      await markReloadRequired("Something changed.");
      await updateExtmgrStatus(ctx, pi);

      const shown = widgets.get("extmgr-attention");
      assert.ok(shown, "expected the attention widget while a reload is pending");
      assert.ok(shown.some((line) => line.includes("reload pending")));
      assert.ok(shown.some((line) => line.includes("/extensions")));

      await clearReloadRequired();
      await updateExtmgrStatus(ctx, pi);

      assert.equal(
        widgets.get("extmgr-attention"),
        undefined,
        "expected the widget to clear once nothing needs attention"
      );
    } finally {
      restoreCatalog();
    }
  });
});

void test("workspace titles are set per screen and restored to pi's format", () => {
  const { ctx, titles } = createMockHarness({ hasUI: true, cwd: "/workspace/demo-project" });

  setWorkspaceTitle(ctx, "installed");
  setWorkspaceTitle(ctx, "health");
  restorePiTitle(ctx);

  assert.deepEqual(titles, ["π - extmgr Installed", "π - extmgr Health", "π - demo-project"]);
});

void test("title updates are skipped outside the TUI", () => {
  const { ctx, titles } = createMockHarness({ hasUI: false });

  setWorkspaceTitle(ctx, "installed");
  restorePiTitle(ctx);

  assert.deepEqual(titles, []);
});
