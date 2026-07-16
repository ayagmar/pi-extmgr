import assert from "node:assert/strict";
import test from "node:test";
import { comparePackageScopes, getPackageScopeLabel } from "../src/packages/scopes.js";

void test("comparePackageScopes identifies project overrides and scope-only packages", () => {
  const result = comparePackageScopes([
    { source: "npm:demo@1.0.0", name: "demo", scope: "global" },
    { source: "npm:demo@1.0.0", name: "demo", scope: "project" },
    { source: "npm:global-only", name: "global-only", scope: "global" },
  ]);

  assert.deepEqual(
    result.map(({ name, status }) => ({ name, status })),
    [
      { name: "demo", status: "overridden" },
      { name: "global-only", status: "global-only" },
    ]
  );
});

void test("getPackageScopeLabel explains persisted package scope", () => {
  assert.match(getPackageScopeLabel("project"), /\.pi\/settings\.json/);
  assert.match(getPackageScopeLabel("global"), /\.pi\/agent\/settings\.json/);
});
