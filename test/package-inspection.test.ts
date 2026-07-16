import assert from "node:assert/strict";
import test from "node:test";
import { inspectPackageMetadata } from "../src/packages/inspection.js";

void test("package metadata inspection reports dependencies and unknown trust safely", () => {
  const inspection = inspectPackageMetadata({
    name: "demo",
    version: "1.0.0",
    dependencies: { zed: "1", alpha: "2" },
    repository: "https://example.test/demo",
  });
  assert.deepEqual(inspection.dependencies, ["alpha", "zed"]);
  assert.equal(inspection.provenance, "unknown");
  assert.equal(inspection.compatibility, "unknown");
});
