import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execNpm, resolveNpmCommand } from "../src/utils/npm-exec.js";

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

void test("resolveNpmCommand honors Pi npmCommand settings", () => {
  const resolved = resolveNpmCommand(["view", "pi-extmgr", "version", "--json"], {
    npmCommand: ["mise", "exec", "node@22", "--", "npm"],
  });

  assert.equal(resolved.command, "mise");
  assert.deepEqual(resolved.args, [
    "exec",
    "node@22",
    "--",
    "npm",
    "view",
    "pi-extmgr",
    "version",
    "--json",
  ]);
});

void test("execNpm uses pi's effective npmCommand setting", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const pi = {
    getSettings: () => ({ npmCommand: ["mise", "exec", "node@22", "--", "npm"] }),
    exec: (command: string, args: string[]) => {
      calls.push({ command, args });
      return Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false });
    },
  } as unknown as ExtensionAPI;

  await execNpm(pi, ["view", "demo", "--json"], { cwd: "/tmp" }, { timeout: 1000 });

  assert.deepEqual(calls, [
    { command: "mise", args: ["exec", "node@22", "--", "npm", "view", "demo", "--json"] },
  ]);
});
