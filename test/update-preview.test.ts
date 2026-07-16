import assert from "node:assert/strict";
import test from "node:test";
import { buildUpdatePreview } from "../src/packages/update-preview.js";

void test("update preview marks only selected available package identities", () => {
  const preview = buildUpdatePreview(
    [
      { source: "npm:a", name: "a", scope: "global", version: "1.0.0" },
      { source: "npm:b", name: "b", scope: "project" },
    ],
    [{ source: "npm:a", displayName: "a", type: "npm", scope: "global" }]
  );
  assert.equal(preview[0]?.updateAvailable, true);
  assert.equal(preview[0]?.metadataKnown, true);
  assert.equal(preview[1]?.updateAvailable, false);
  assert.equal(preview[1]?.metadataKnown, false);
});
