import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPackageExtensionStateChanges } from "../src/packages/extensions.js";

async function withAgentDir(run: (paths: { agentDir: string; cwd: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-settings-writers-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await run({ agentDir, cwd });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

void test("global package filters are written to global settings without trusted project packages", async () => {
  await withAgentDir(async ({ agentDir, cwd }) => {
    const globalSettings = {
      extensions: ["-builtin:mcp"],
      defaultTools: ["-write"],
      quietStartup: "header",
      packages: ["npm:global-demo", { source: "npm:other", skills: [], autoload: false }],
    };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(globalSettings), "utf8");
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:project-only"] }),
      "utf8"
    );

    const result = await applyPackageExtensionStateChanges(
      "npm:global-demo",
      "global",
      [{ extensionPath: "extensions/a.ts", target: "disabled" }],
      cwd,
      true
    );

    assert.deepEqual(result, { ok: true });
    const saved = await readJson(join(agentDir, "settings.json"));
    assert.deepEqual(saved.packages, [
      { source: "npm:global-demo", extensions: ["-extensions/a.ts"] },
      { source: "npm:other", skills: [], autoload: false },
    ]);
    assert.deepEqual(saved.extensions, ["-builtin:mcp"]);
    assert.deepEqual(saved.defaultTools, ["-write"]);
    assert.equal(saved.quietStartup, "header");
    assert.deepEqual((await readJson(join(cwd, ".pi", "settings.json"))).packages, [
      "npm:project-only",
    ]);
  });
});
