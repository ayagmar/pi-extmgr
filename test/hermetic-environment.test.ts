import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getExtmgrCacheDir } from "../src/utils/pi-paths.js";

function isInside(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate);
}

void test("test process redirects Pi state and user directories into one temporary sandbox", () => {
  const home = homedir();
  const agentDir = getAgentDir();
  const cacheDir = getExtmgrCacheDir();
  const sandboxRoot = dirname(home);

  assert.match(sandboxRoot, /pi-extmgr-test-process-/);
  assert.equal(isInside(sandboxRoot, agentDir), true);
  assert.equal(isInside(sandboxRoot, cacheDir), true);
  assert.equal(isInside(sandboxRoot, process.env.npm_config_cache ?? ""), true);
  assert.equal(isInside(sandboxRoot, process.env.npm_config_prefix ?? ""), true);
  assert.equal(isInside(sandboxRoot, process.env.PATH ?? ""), true);
  assert.equal(isInside(sandboxRoot, process.env.PI_EXTMGR_TEST_CWD ?? ""), true);
});

void test("test process rejects network access unless a test installs an explicit fetch stub", async () => {
  await assert.rejects(
    () => fetch("https://example.test/should-not-run"),
    /Unexpected network access/
  );
});
