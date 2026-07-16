import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectInstalledPackageCompatibility,
  validateCompatibility,
} from "../src/doctor/compatibility.js";

void test("compatibility diagnostics reject packages requiring newer runtimes", () => {
  const diagnostic = validateCompatibility({
    packageName: "demo",
    engines: { node: ">=24" },
    requiredPi: ">=0.90",
    nodeVersion: "22.20.0",
    piVersion: "0.80.0",
  });
  assert.equal(diagnostic.node, "incompatible");
  assert.equal(diagnostic.pi, "incompatible");
  assert.equal(diagnostic.reasons.length, 2);
});

void test("installed package compatibility reports Node results and unknown Pi metadata", async () => {
  const diagnostics = await inspectInstalledPackageCompatibility([
    {
      source: "npm:demo",
      name: "demo",
      scope: "project",
      resolvedPath: "/missing/package",
    },
  ]);
  assert.equal(diagnostics[0]?.node, "unknown");
  assert.equal(diagnostics[0]?.pi, "unknown");
});

void test("missing compatibility metadata is reported as unknown", () => {
  assert.deepEqual(validateCompatibility({ packageName: "demo" }).reasons, []);
  assert.equal(validateCompatibility({ packageName: "demo" }).node, "unknown");
});
