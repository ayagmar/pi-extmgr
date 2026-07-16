import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPackageCatalog } from "../src/packages/catalog.js";
import {
  comparePackageScopes,
  getPackageScopeLabel,
  movePackageBetweenScopes,
} from "../src/packages/scopes.js";

void test("comparePackageScopes identifies project overrides and scope-only packages", () => {
  const result = comparePackageScopes([
    { source: "npm:demo@1.0.0", name: "demo", scope: "global" },
    { source: "npm:demo@1.0.0", name: "demo", scope: "project" },
    { source: "npm:global-only", name: "global-only", scope: "global" },
  ]);

  assert.deepEqual(
    result.map(({ name, status }) => ({ name, status })),
    [
      { name: "demo", status: "overridden" },
      { name: "global-only", status: "global-only" },
    ]
  );
});

void test("movePackageBetweenScopes preserves filters, unknown fields, and effective state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-scopes-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          {
            source: "npm:demo@1.2.3",
            extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
            unknownPackageField: { keep: true },
          },
        ],
        unrelated: { keep: true },
      }),
      "utf8"
    );

    const result = await movePackageBetweenScopes("npm:demo@1.2.3", "global", "project", cwd);
    assert.equal(result.moved, true);

    const globalSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages?: unknown[];
      unrelated?: unknown;
    };
    const projectSettings = JSON.parse(
      await readFile(join(cwd, ".pi", "settings.json"), "utf8")
    ) as { packages?: Array<Record<string, unknown>> };
    assert.deepEqual(globalSettings.packages, []);
    assert.deepEqual(globalSettings.unrelated, { keep: true });
    assert.deepEqual(projectSettings.packages?.[0], {
      source: "npm:demo@1.2.3",
      extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
      unknownPackageField: { keep: true },
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

void test("movePackageBetweenScopes refuses a conflicting destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-scopes-conflict-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:demo@1.0.0"] }),
      "utf8"
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:demo@2.0.0"] }),
      "utf8"
    );
    const result = await movePackageBetweenScopes("npm:demo@1.0.0", "global", "project", cwd);
    assert.equal(result.moved, false);
    assert.match(result.conflict ?? "", /different package configuration/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

void test("package mutations refuse malformed settings without reporting success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-scopes-malformed-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), "{ invalid", "utf8");

    await assert.rejects(
      () => getPackageCatalog(cwd).install("npm:demo", "global"),
      /Package installation refused/
    );
    const moved = await movePackageBetweenScopes("npm:demo", "global", "project", cwd);
    assert.equal(moved.moved, false);
    assert.match(moved.conflict ?? "", /Package scope move refused/);
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), "{ invalid");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

void test("getPackageScopeLabel explains persisted package scope", () => {
  assert.match(getPackageScopeLabel("project"), /\.pi\/settings\.json/);
  assert.match(getPackageScopeLabel("global"), /\.pi\/agent\/settings\.json/);
});
