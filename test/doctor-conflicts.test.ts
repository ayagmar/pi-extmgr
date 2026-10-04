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

function commandOwner(
  overrides: Partial<Parameters<typeof findRuntimeConflicts>[0][number]>
): Parameters<typeof findRuntimeConflicts>[0][number] {
  return {
    kind: "command",
    name: "deploy",
    source: "auto",
    scope: "user",
    origin: "top-level",
    path: "/home/user/.pi/agent/extensions/a.ts",
    ...overrides,
  };
}

void test("runtime conflicts tell auto-discovered extensions apart by path", () => {
  const conflicts = findRuntimeConflicts([
    commandOwner({ path: "/home/user/.pi/agent/extensions/a.ts" }),
    commandOwner({ path: "/home/user/.pi/agent/extensions/b.ts" }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.owners.length, 2);
});

void test("runtime conflicts report user vs project auto-discovered clashes", () => {
  const conflicts = findRuntimeConflicts([
    commandOwner({ path: "/home/user/.pi/agent/extensions/a.ts" }),
    commandOwner({ scope: "project", path: "/repo/.pi/extensions/a.ts" }),
  ]);
  assert.equal(conflicts.length, 1);
});

void test("runtime conflicts ignore a name registered twice by the same file", () => {
  assert.deepEqual(findRuntimeConflicts([commandOwner({}), commandOwner({})]), []);
});

void test("runtime conflicts never report tools, which pi keeps one of per name", () => {
  assert.deepEqual(
    findRuntimeConflicts([
      commandOwner({ kind: "tool", name: "grep", path: "/a.ts" }),
      commandOwner({ kind: "tool", name: "grep", path: "/b.ts" }),
    ]),
    []
  );
});
