import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "pi-extmgr-test-process-"));
const sandboxHome = join(sandboxRoot, "home");
const agentDir = join(sandboxHome, ".pi", "agent");
const cacheDir = join(agentDir, ".extmgr-cache");
const emptyBinDir = join(sandboxRoot, "bin");
const projectDir = join(sandboxRoot, "project");

for (const directory of [sandboxHome, agentDir, cacheDir, emptyBinDir, projectDir]) {
  mkdirSync(directory, { recursive: true });
}

Object.assign(process.env, {
  HOME: sandboxHome,
  USERPROFILE: sandboxHome,
  XDG_CACHE_HOME: join(sandboxRoot, "xdg-cache"),
  XDG_CONFIG_HOME: join(sandboxRoot, "xdg-config"),
  XDG_DATA_HOME: join(sandboxRoot, "xdg-data"),
  PI_CODING_AGENT_DIR: agentDir,
  PI_EXTMGR_CACHE_DIR: cacheDir,
  PI_EXTMGR_TEST_CWD: projectDir,
  npm_config_cache: join(sandboxRoot, "npm-cache"),
  npm_config_prefix: join(sandboxRoot, "npm-prefix"),
  GIT_CONFIG_GLOBAL: join(sandboxRoot, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: emptyBinDir,
});

globalThis.fetch = async (input) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Unexpected network access from test: ${target}`);
};

process.once("exit", () => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});
