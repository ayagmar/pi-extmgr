import assert from "node:assert/strict";
import test from "node:test";
import { isWithinMaintenanceWindow, shouldUpdate } from "../src/packages/update-policy.js";

void test("update policies honor ordinary and overnight maintenance windows", () => {
  const policy = {
    packageSource: "npm:demo",
    enabled: true,
    maintenanceWindow: { startHour: 22, endHour: 2 },
  };
  assert.equal(isWithinMaintenanceWindow(policy, new Date(2026, 0, 1, 23)), true);
  assert.equal(isWithinMaintenanceWindow(policy, new Date(2026, 0, 1, 1)), true);
  assert.equal(isWithinMaintenanceWindow(policy, new Date(2026, 0, 1, 12)), false);
  assert.equal(shouldUpdate(policy, new Date(2026, 0, 1, 12)), false);
});
