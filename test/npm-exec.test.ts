import assert from "node:assert/strict";
import test from "node:test";
import { resolveNpmCommand, resolveNpmRootCommand } from "../src/utils/npm-exec.js";

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

void test("resolveNpmRootCommand detects path-qualified bun commands", () => {
  const oldGlobalDir = process.env.BUN_INSTALL_GLOBAL_DIR;
  process.env.BUN_INSTALL_GLOBAL_DIR = "/opt/bun/global";

  try {
    const resolved = resolveNpmRootCommand({ npmCommand: ["/usr/local/bin/bun"] });

    assert.equal(resolved.command, "/usr/local/bin/bun");
    assert.deepEqual(resolved.args, ["pm", "bin", "-g"]);
    assert.equal(resolved.getRoot("/home/alice/.bun/bin\n"), "/opt/bun/global/node_modules");
  } finally {
    if (oldGlobalDir === undefined) {
      delete process.env.BUN_INSTALL_GLOBAL_DIR;
    } else {
      process.env.BUN_INSTALL_GLOBAL_DIR = oldGlobalDir;
    }
  }
});

void test("resolveNpmRootCommand detects bun.cmd commands", () => {
  const oldGlobalDir = process.env.BUN_INSTALL_GLOBAL_DIR;
  process.env.BUN_INSTALL_GLOBAL_DIR = "/opt/bun/global";

  try {
    const resolved = resolveNpmRootCommand({ npmCommand: ["bun.cmd"] });

    assert.equal(resolved.command, "bun.cmd");
    assert.deepEqual(resolved.args, ["pm", "bin", "-g"]);
    assert.equal(resolved.getRoot("/home/alice/.bun/bin\n"), "/opt/bun/global/node_modules");
  } finally {
    if (oldGlobalDir === undefined) {
      delete process.env.BUN_INSTALL_GLOBAL_DIR;
    } else {
      process.env.BUN_INSTALL_GLOBAL_DIR = oldGlobalDir;
    }
  }
});
