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
