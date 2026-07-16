import assert from "node:assert/strict";
import test from "node:test";
import { findRuntimeConflicts } from "../src/doctor/conflicts.js";

void test("runtime conflict detection reports same names owned by different sources", () => {
  const conflicts = findRuntimeConflicts([
    {
      kind: "command",
      name: "demo",
      source: "npm:a",
      scope: "user",
      origin: "package",
      path: "/a",
    },
    {
      kind: "command",
      name: "demo",
      source: "npm:b",
      scope: "project",
      origin: "package",
      path: "/b",
    },
    { kind: "tool", name: "demo", source: "npm:a", scope: "user", origin: "package", path: "/a" },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.name, "demo");
  assert.equal(conflicts[0]?.owners.length, 2);
});
