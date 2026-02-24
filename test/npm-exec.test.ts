import test from "node:test";
import assert from "node:assert/strict";
import { resolveNpmCommand } from "../src/utils/npm-exec.js";

void test("resolveNpmCommand uses npm directly on non-windows", () => {
  const resolved = resolveNpmCommand(["view", "pi-extmgr", "version", "--json"], {
    platform: "linux",
  });

  assert.equal(resolved.command, "npm");
  assert.deepEqual(resolved.args, ["view", "pi-extmgr", "version", "--json"]);
});

void test("resolveNpmCommand uses node + npm-cli.js on windows", () => {
  const resolved = resolveNpmCommand(["search", "--json", "pi-extmgr"], {
    platform: "win32",
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.equal(resolved.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(resolved.args, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "search",
    "--json",
    "pi-extmgr",
  ]);
});
