import assert from "node:assert/strict";
import test from "node:test";
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
