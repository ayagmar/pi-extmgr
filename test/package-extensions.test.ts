import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackageExtensions, setPackageExtensionState } from "../src/packages/extensions.js";
import type { InstalledPackage } from "../src/types/index.js";

void test("discoverPackageExtensions expands manifest glob entrypoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "glob-manifest");

  try {
    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "glob-manifest", pi: { extensions: ["extensions/*.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "extensions", "a.ts"), "// a\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "b.ts"), "// b\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "c.js"), "// c\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/glob-manifest",
        name: "glob-manifest",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.deepEqual(
      discovered.map((entry) => entry.extensionPath),
      ["extensions/a.ts", "extensions/b.ts"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverPackageExtensions resolves manifest directory entrypoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "dir-manifest");

  try {
    await mkdir(join(pkgRoot, "extensions", "sub"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "dir-manifest", pi: { extensions: ["extensions"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "extensions", "index.ts"), "// index\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "sub", "feature.js"), "// feature\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/dir-manifest",
        name: "dir-manifest",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.deepEqual(
      discovered.map((entry) => entry.extensionPath),
      ["extensions/index.ts", "extensions/sub/feature.js"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverPackageExtensions resolves directory tokens with trailing slash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "dir-manifest-trailing");

  try {
    await mkdir(join(pkgRoot, "extensions", "sub"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        { name: "dir-manifest-trailing", pi: { extensions: ["extensions/"] } },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(pkgRoot, "extensions", "index.ts"), "// index\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "sub", "feature.js"), "// feature\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/dir-manifest-trailing",
        name: "dir-manifest-trailing",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.deepEqual(
      discovered.map((entry) => entry.extensionPath),
      ["extensions/index.ts", "extensions/sub/feature.js"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

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

void test("discoverPackageExtensions treats explicit empty extensions filter as all disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "empty-filter");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        { name: "empty-filter", pi: { extensions: ["./extensions/a.ts", "./extensions/b.ts"] } },
        null,
        2
      ),
      "utf8"
    );
    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await writeFile(join(pkgRoot, "extensions", "a.ts"), "// a\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "b.ts"), "// b\n", "utf8");

    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify(
        {
          packages: [{ source: "./vendor/empty-filter", extensions: [] }],
        },
        null,
        2
      ),
      "utf8"
    );

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/empty-filter",
        name: "empty-filter",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.equal(discovered.length, 2);
    assert.ok(discovered.every((entry) => entry.state === "disabled"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverPackageExtensions applies include and exclude filter patterns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "pattern-filter");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        {
          name: "pattern-filter",
          pi: { extensions: ["./extensions/a.ts", "./extensions/b.ts", "./extensions/c.js"] },
        },
        null,
        2
      ),
      "utf8"
    );

    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await writeFile(join(pkgRoot, "extensions", "a.ts"), "// a\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "b.ts"), "// b\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "c.js"), "// c\n", "utf8");

    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify(
        {
          packages: [
            {
              source: "./vendor/pattern-filter",
              extensions: ["extensions/*.ts", "!extensions/b.ts"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/pattern-filter",
        name: "pattern-filter",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    const byPath = new Map(discovered.map((entry) => [entry.extensionPath, entry.state]));

    assert.equal(byPath.get("extensions/a.ts"), "enabled");
    assert.equal(byPath.get("extensions/b.ts"), "disabled");
    assert.equal(byPath.get("extensions/c.js"), "disabled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverPackageExtensions handles invalid filter glob patterns safely", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, "vendor", "invalid-glob");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "invalid-glob", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// index\n", "utf8");

    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify(
        {
          packages: [{ source: "./vendor/invalid-glob", extensions: ["[invalid"] }],
        },
        null,
        2
      ),
      "utf8"
    );

    const installed: InstalledPackage[] = [
      {
        source: "./vendor/invalid-glob",
        name: "invalid-glob",
        scope: "project",
        resolvedPath: pkgRoot,
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.state, "disabled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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

void test("discoverPackageExtensions resolves npm project package without resolvedPath", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const pkgRoot = join(cwd, ".pi", "npm", "node_modules", "demo-project");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo-project", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// project package\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "npm:demo-project",
        name: "demo-project",
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

void test("discoverPackageExtensions resolves npm global package via PI_PACKAGE_DIR", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const packageDir = await mkdtemp(join(tmpdir(), "pi-extmgr-package-dir-"));
  const oldPackageDir = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = packageDir;

  const pkgRoot = join(packageDir, "npm", "node_modules", "demo-global");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo-global", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// global package\n", "utf8");

    const installed: InstalledPackage[] = [
      {
        source: "npm:demo-global",
        name: "demo-global",
        scope: "global",
      },
    ];

    const discovered = await discoverPackageExtensions(installed, cwd);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.extensionPath, "index.ts");
  } finally {
    if (oldPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = oldPackageDir;
    }

    await rm(cwd, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
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

void test("setPackageExtensionState preserves non-marker extension tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extmgr-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const settingsPath = join(agentDir, "settings.json");

  try {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          packages: [
            {
              source: "npm:demo-pkg@1.0.0",
              extensions: ["notes:keep", "-extensions/main.ts"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await setPackageExtensionState(
      "npm:demo-pkg@1.0.0",
      "extensions/main.ts",
      "global",
      "enabled",
      cwd
    );

    assert.equal(result.ok, true);

    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as {
      packages: { source: string; extensions: string[] }[];
    };

    assert.deepEqual(saved.packages[0]?.extensions, ["notes:keep", "+extensions/main.ts"]);
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
