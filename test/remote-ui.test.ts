import assert from "node:assert/strict";
import test from "node:test";
import { clearSearchCache, setSearchCache } from "../src/packages/discovery.js";
import { browseRemotePackages } from "../src/ui/remote.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("browseRemotePackages honors an empty in-memory cache", async () => {
  setSearchCache({
    query: "no-results",
    results: [],
    timestamp: Date.now(),
  });

  const { pi, ctx, notifications } = createMockHarness({ hasUI: true });
  let customCalls = 0;

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = () => {
    customCalls += 1;
    return Promise.resolve(undefined);
  };

  try {
    await browseRemotePackages(ctx, "no-results", pi);

    assert.equal(customCalls, 0);
    assert.ok(
      notifications.some((entry) => entry.message.includes("No packages found for: no-results"))
    );
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages returns to package details after a cancelled load", async () => {
  setSearchCache({
    query: "demo",
    results: [
      {
        name: "demo-pkg",
        version: "1.0.0",
        description: "Demo package",
      },
    ],
    timestamp: Date.now(),
  });

  const { pi, ctx, notifications, selectPrompts } = createMockHarness({ hasUI: true });
  const customResults: unknown[] = [
    { type: "package", name: "demo-pkg" },
    undefined,
    { type: "cancel" },
  ];
  const selectResults = ["View npm info", "Back to results"];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = () => Promise.resolve(customResults.shift());
  (ctx.ui as { select: (title: string, items?: string[]) => Promise<string | undefined> }).select =
    (title) => {
      selectPrompts.push(title);
      return Promise.resolve(selectResults.shift());
    };

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.equal(selectPrompts.filter((title) => title === "demo-pkg").length, 2);
    assert.ok(
      notifications.some((entry) =>
        entry.message.includes("Loading demo-pkg details was cancelled.")
      )
    );
  } finally {
    clearSearchCache();
  }
});
