import assert from "node:assert/strict";
import test from "node:test";
import { findRuntimeConflicts } from "../src/doctor/conflicts.js";
import { getRuntimeOwners } from "../src/doctor/runtime.js";

void test("runtime ownership explorer uses public command and tool metadata", () => {
  const owners = getRuntimeOwners({
    getCommands: () => [
      {
        name: "demo",
        source: "extension",
        sourceInfo: { source: "npm:demo", scope: "project", origin: "package", path: "/tmp/demo" },
      },
    ],
    getAllTools: () => [
      {
        name: "demo_tool",
        description: "A demo tool",
        sourceInfo: { source: "npm:demo", scope: "project", origin: "package", path: "/tmp/demo" },
      },
    ],
  } as never);

  assert.deepEqual(
    owners.map((owner) => [owner.kind, owner.name, owner.source]),
    [
      ["command", "demo", "npm:demo"],
      ["tool", "demo_tool", "npm:demo"],
    ]
  );
});

void test("runtime ownership recovers command names pi suffixed for duplicate registrations", () => {
  const owners = getRuntimeOwners({
    getCommands: () => [
      {
        name: "deploy:1",
        source: "extension",
        sourceInfo: { source: "npm:one", scope: "user", origin: "package", path: "/tmp/one" },
      },
      {
        name: "deploy:2",
        source: "extension",
        sourceInfo: { source: "npm:two", scope: "user", origin: "package", path: "/tmp/two" },
      },
      {
        name: "release:2",
        source: "extension",
        sourceInfo: { source: "npm:three", scope: "user", origin: "package", path: "/tmp/three" },
      },
    ],
    getAllTools: () => [],
  } as never);

  assert.deepEqual(
    owners.map((owner) => [owner.name, owner.source]),
    [
      ["deploy", "npm:one"],
      ["deploy", "npm:two"],
      ["release:2", "npm:three"],
    ]
  );
  assert.deepEqual(
    findRuntimeConflicts(owners).map((conflict) => conflict.name),
    ["deploy"]
  );
});
