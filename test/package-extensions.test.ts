import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackageExtensions, setPackageExtensionState } from "../src/packages/extensions.js";
import type { InstalledPackage } from "../src/types/index.js";

void test("discoverPackageExtensions reads manifest entrypoints and project filter state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  await mkdir(pkgRoot, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });

  await writeFile(
    join(pkgRoot, "package.json"),
    JSON.stringify({ name: "demo", pi: { extensions: ["./index.ts"] } }, null, 2),
    "utf8"
  );
  await writeFile(join(pkgRoot, "index.ts"), "// demo extension\n", "utf8");

  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        packages: [{ source: "./vendor/demo", extensions: ["-index.ts"] }],
      },
      null,
      2
    ),
    "utf8"
  );

  const installed: InstalledPackage[] = [
    {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: pkgRoot,
    },
  ];

  const discovered = await discoverPackageExtensions(installed, cwd);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.extensionPath, "index.ts");
  assert.equal(discovered[0]?.state, "disabled");
});

void test("setPackageExtensionState converts string package entries and keeps latest marker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extmgr-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:demo-pkg@1.0.0"] }, null, 2),
      "utf8"
    );

    const disableResult = await setPackageExtensionState(
      "npm:demo-pkg@1.0.0",
      "./extensions/main.ts",
      "global",
      "disabled",
      cwd
    );
    assert.equal(disableResult.ok, true);

    const afterDisable = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages: (string | { source: string; extensions?: string[] })[];
    };
    const firstEntry = afterDisable.packages[0];
    assert.equal(typeof firstEntry, "object");
    assert.deepEqual(firstEntry, {
      source: "npm:demo-pkg@1.0.0",
      extensions: ["-extensions/main.ts"],
    });

    const enableResult = await setPackageExtensionState(
      "npm:demo-pkg@1.0.0",
      "extensions/main.ts",
      "global",
      "enabled",
      cwd
    );
    assert.equal(enableResult.ok, true);

    const afterEnable = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages: (string | { source: string; extensions?: string[] })[];
    };
    const enabledEntry = afterEnable.packages[0] as { source: string; extensions?: string[] };
    assert.deepEqual(enabledEntry.extensions, ["+extensions/main.ts"]);
  } finally {
    if (oldAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
  }
});

void test("discoverPackageExtensions resolves file:// package sources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "filepkg");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "filepkg", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// file package extension\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: `file://${pkgRoot}`,
        name: "filepkg",
        scope: "project",
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.extensionPath, "index.ts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverPackageExtensions handles resolved package.json paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "manifest-path-pkg");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "manifest-path-pkg", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// manifest path package extension\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "npm:manifest-path-pkg@1.0.0",
        name: "manifest-path-pkg",
        scope: "project",
        resolvedPath: join(pkgRoot, "package.json"),
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.extensionPath, "index.ts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("setPackageExtensionState fails safely when settings.json is invalid", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extmgr-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const settingsPath = join(agentDir, "settings.json");

  try {
    await writeFile(settingsPath, "{ invalid json", "utf8");

    const result = await setPackageExtensionState(
      "npm:demo-pkg@1.0.0",
      "extensions/main.ts",
      "global",
      "disabled",
      cwd
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Invalid JSON/);
    }

    const raw = await readFile(settingsPath, "utf8");
    assert.equal(raw, "{ invalid json");
  } finally {
    if (oldAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }

    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
