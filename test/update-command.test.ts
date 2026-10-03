import assert from "node:assert/strict";
import test from "node:test";
import { handleUpdateSubcommand } from "../src/commands/update.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("update --preview reports updates without mutating packages", async () => {
  let updates = 0;
  const restore = mockPackageCatalog({
    packages: [{ source: "npm:demo", name: "demo", version: "1.0.0", scope: "global" }],
    updates: [{ source: "npm:demo", displayName: "demo", type: "npm", scope: "global" }],
    updateImpl: () => {
      updates += 1;
    },
  });
  try {
    const { pi, ctx, notifications } = createMockHarness({ hasUI: true });
    await handleUpdateSubcommand(["--preview"], ctx, pi);
    assert.equal(updates, 0);
    assert.ok(notifications.some((entry) => entry.message.includes("demo@1.0.0")));
  } finally {
    restore();
  }
});

void test("updating several sources offers one reload and never reuses the reloaded context", async () => {
  const updated: string[] = [];
  const restore = mockPackageCatalog({
    packages: [
      { source: "npm:alpha", name: "alpha", version: "1.0.0", scope: "global" },
      { source: "npm:beta", name: "beta", version: "1.0.0", scope: "global" },
    ],
    updates: [
      { source: "npm:alpha", displayName: "alpha", type: "npm", scope: "global" },
      { source: "npm:beta", displayName: "beta", type: "npm", scope: "global" },
    ],
    updateImpl: (source) => {
      if (source) updated.push(source);
    },
  });
  try {
    const { pi, ctx, confirmPrompts, reloadCount } = createMockHarness({
      hasUI: true,
      confirmResult: true,
      staleAfterReload: true,
    });
    await handleUpdateSubcommand(["npm:alpha", "npm:beta"], ctx, pi);
    assert.deepEqual(updated, ["npm:alpha", "npm:beta"]);
    assert.equal(confirmPrompts.filter((title) => title === "Reload Required").length, 1);
    assert.equal(reloadCount(), 1);
  } finally {
    restore();
  }
});
