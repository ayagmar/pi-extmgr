import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

// Keep hydration persistence away from the real extmgr cache.
process.env.PI_EXTMGR_CACHE_DIR = mkdtempSync(join(tmpdir(), "pi-extmgr-hydration-"));
import { clearSearchCache, setSearchCache } from "../src/packages/discovery.js";
import { browseRemotePackages } from "../src/ui/remote.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { type NpmPackage } from "../src/types/index.js";

initTheme();

function setSearchPage(
  query: string,
  results: NpmPackage[],
  total = results.length,
  offset = 0
): void {
  setSearchCache({ query, results, total, offset, timestamp: Date.now() });
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

void test("browse hydrates weekly downloads in the background without delaying results", async () => {
  setSearchPage("hydrate", [
    { name: "hydrate-target", version: "1.0.0", description: "Needs metrics" },
  ]);

  const originalFetch = globalThis.fetch;
  let downloadFetches = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("api.npmjs.org/downloads")) {
      return Promise.resolve(new Response("{}", { status: 500 }));
    }
    downloadFetches += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ package: "hydrate-target", downloads: 4321 }), {
        status: 200,
      })
    );
  }) as typeof fetch;

  const { pi, ctx } = createMockHarness({ hasUI: true });
  let initialLines: string[] = [];
  let hydratedLines: string[] = [];

  (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, async (component, lines) => {
      // Rows are visible immediately, before metrics land.
      initialLines = lines;
      // Poll: hydration persists metadata to the on-disk cache before finishing.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await nextTick();
        hydratedLines = component.render(120);
        if (hydratedLines.some((line) => line.includes("4.3K/wk"))) break;
      }
      return { type: "cancel" };
    });

  try {
    await browseRemotePackages(ctx, "hydrate", pi);

    assert.ok(initialLines.some((line) => line.includes("hydrate-target@1.0.0")));
    assert.ok(
      !initialLines.some((line) => line.includes("4.3K/wk")),
      "metrics must not block the initial render"
    );
    assert.equal(downloadFetches, 1);
    assert.ok(
      hydratedLines.some((line) => line.includes("4.3K/wk")),
      "hydrated metrics should appear in rows after background fetch"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browse skips download hydration when metrics are already known", async () => {
  setSearchPage("known", [
    { name: "known-pkg", version: "1.0.0", description: "Cached metrics", weeklyDownloads: 900 },
  ]);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  const { pi, ctx } = createMockHarness({ hasUI: true });
  (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, async () => {
      await nextTick();
      return { type: "cancel" };
    });

  try {
    await browseRemotePackages(ctx, "known", pi);
    assert.equal(fetchCalls, 0, "no network work when weekly downloads are already cached");
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browse aborts download hydration when the screen is disposed", async () => {
  setSearchPage("abort", [{ name: "abort-target", version: "1.0.0", description: "Slow metrics" }]);

  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    })) as typeof fetch;

  const { pi, ctx } = createMockHarness({ hasUI: true });
  (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, () => ({ type: "cancel" }));

  try {
    await browseRemotePackages(ctx, "abort", pi);
    await nextTick();
    assert.equal(aborted, true, "disposal must abort in-flight metadata fetches");
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browse ignores hydration failures and keeps rendering", async () => {
  setSearchPage("failing", [
    { name: "failing-target", version: "1.0.0", description: "Metrics fail" },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

  const { pi, ctx } = createMockHarness({ hasUI: true });
  let renderedAfterFailure: string[] = [];
  (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, async (component) => {
      await nextTick();
      renderedAfterFailure = component.render(120);
      return { type: "cancel" };
    });

  try {
    await browseRemotePackages(ctx, "failing", pi);
    assert.ok(renderedAfterFailure.some((line) => line.includes("failing-target@1.0.0")));
    assert.ok(!renderedAfterFailure.some((line) => line.includes("/wk")));
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});
