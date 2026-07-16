import assert from "node:assert/strict";
import test from "node:test";
import { validateCompatibility } from "../src/doctor/compatibility.js";

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

void test("missing compatibility metadata is reported as unknown", () => {
  assert.deepEqual(validateCompatibility({ packageName: "demo" }).reasons, []);
  assert.equal(validateCompatibility({ packageName: "demo" }).node, "unknown");
});
