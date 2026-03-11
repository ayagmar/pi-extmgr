import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, State } from "../src/types/index.js";
import { discoverPackageExtensions } from "../src/packages/extensions.js";
import {
  applyPackageExtensionChanges,
  buildPackageConfigRows,
  configurePackageExtensions,
} from "../src/ui/package-config.js";
import { createMockHarness } from "./helpers/mocks.js";

function createPiRecorder() {
  const entries: { customType: string; data: unknown }[] = [];

  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  return { pi, entries };
}

void test("buildPackageConfigRows deduplicates duplicate extension paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));

  try {
    const file = join(cwd, "index.ts");
    await writeFile(file, "// demo\n", "utf8");

    const pkg: InstalledPackage = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: cwd,
    };

    const rows = await buildPackageConfigRows([
      {
        id: "one",
        packageSource: pkg.source,
        packageName: pkg.name,
        packageScope: pkg.scope,
        extensionPath: "index.ts",
        absolutePath: file,
        displayName: "demo/index.ts",
        summary: "first",
        state: "enabled",
      },
      {
        id: "two",
        packageSource: pkg.source,
        packageName: pkg.name,
        packageScope: pkg.scope,
        extensionPath: "index.ts",
        absolutePath: file,
        displayName: "demo/index.ts",
        summary: "second",
        state: "disabled",
      },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.extensionPath, "index.ts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("buildPackageConfigRows marks missing manifest entrypoints as unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo", pi: { extensions: ["./index.ts", "./missing.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// demo extension\n", "utf8");

    const pkg: InstalledPackage = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: pkgRoot,
    };

    const discovered = await discoverPackageExtensions([pkg], cwd);
    const rows = await buildPackageConfigRows(discovered);

    assert.equal(rows.length, 2);

    const indexRow = rows.find((row) => row.extensionPath === "index.ts");
    const missingRow = rows.find((row) => row.extensionPath === "missing.ts");

    assert.equal(indexRow?.available, true);
    assert.equal(missingRow?.available, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("applyPackageExtensionChanges applies changed rows and preserves non-marker extension tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
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
          packages: [
            {
              source: "./vendor/demo",
              extensions: ["notes:keep", "-index.ts"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const pkg: InstalledPackage = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: pkgRoot,
    };

    const discovered = await discoverPackageExtensions([pkg], cwd);
    const rows = await buildPackageConfigRows(discovered);

    const staged = new Map<string, State>();
    const row = rows.find((entry) => entry.extensionPath === "index.ts");
    assert.ok(row);
    staged.set(row.id, "enabled");

    const { pi } = createPiRecorder();
    const result = await applyPackageExtensionChanges(rows, staged, pkg, cwd, pi);

    assert.equal(result.changed, 1);
    assert.equal(result.errors.length, 0);

    const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")) as {
      packages: { source: string; extensions: string[] }[];
    };

    assert.deepEqual(saved.packages[0]?.extensions, ["notes:keep", "+index.ts"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("applyPackageExtensionChanges batches multiple row changes in one save", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        { name: "demo", pi: { extensions: ["./extensions/a.ts", "./extensions/b.ts"] } },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(pkgRoot, "extensions", "a.ts"), "// a\n", "utf8");
    await writeFile(join(pkgRoot, "extensions", "b.ts"), "// b\n", "utf8");
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify(
        {
          packages: [
            {
              source: "./vendor/demo",
              extensions: ["notes:keep", "+extensions/a.ts"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const pkg: InstalledPackage = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: pkgRoot,
    };

    const discovered = await discoverPackageExtensions([pkg], cwd);
    const rows = await buildPackageConfigRows(discovered);

    const staged = new Map<string, State>();
    staged.set(rows.find((entry) => entry.extensionPath === "extensions/a.ts")!.id, "disabled");
    staged.set(rows.find((entry) => entry.extensionPath === "extensions/b.ts")!.id, "enabled");

    const { pi } = createPiRecorder();
    const result = await applyPackageExtensionChanges(rows, staged, pkg, cwd, pi);

    assert.equal(result.changed, 2);
    assert.equal(result.errors.length, 0);

    const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")) as {
      packages: { source: string; extensions: string[] }[];
    };

    assert.deepEqual(saved.packages[0]?.extensions, [
      "notes:keep",
      "-extensions/a.ts",
      "+extensions/b.ts",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("applyPackageExtensionChanges reports settings parse failure and logs failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// demo extension\n", "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), "{ invalid json", "utf8");

    const pkg: InstalledPackage = {
      source: "./vendor/demo",
      name: "demo",
      scope: "project",
      resolvedPath: pkgRoot,
    };

    const discovered = await discoverPackageExtensions([pkg], cwd);
    const rows = await buildPackageConfigRows(discovered);

    const staged = new Map<string, State>();
    const row = rows.find((entry) => entry.extensionPath === "index.ts");
    assert.ok(row);
    staged.set(row.id, "disabled");

    const { pi, entries } = createPiRecorder();
    const result = await applyPackageExtensionChanges(rows, staged, pkg, cwd, pi);

    assert.equal(result.changed, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /Invalid JSON/);
    assert.equal(entries.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("configurePackageExtensions surfaces invalid settings before rendering fake state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-package-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// demo extension\n", "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), "{ invalid json", "utf8");

    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      hasCustomUI: true,
    });

    const result = await configurePackageExtensions(
      {
        source: "./vendor/demo",
        name: "demo",
        scope: "project",
        resolvedPath: pkgRoot,
      },
      ctx,
      pi
    );

    assert.deepEqual(result, { changed: 0, reloaded: false });
    assert.equal(customCallCount(), 0);
    assert.ok(notifications.some((entry) => /Invalid JSON/.test(entry.message)));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
