import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstalledPackagesOutput } from "../src/packages/discovery.js";
import { discoverPackageExtensions } from "../src/packages/extensions.js";
import type { InstalledPackage, PackageExtensionEntry } from "../src/types/index.js";
import { buildUnifiedItems } from "../src/ui/unified.js";

function createPackage(source: string, name: string): InstalledPackage {
  return {
    source,
    name,
    scope: "global",
  };
}

function createPackageExtension(
  id: string,
  packageSource: string,
  extensionPath: string,
  state: "enabled" | "disabled" = "enabled"
): PackageExtensionEntry {
  return {
    id,
    packageSource,
    packageName: "pi-extmgr",
    packageScope: "global",
    extensionPath,
    absolutePath: `/tmp/${extensionPath}`,
    displayName: `pi-extmgr/${extensionPath}`,
    summary: "package extension",
    state,
  };
}

void test("buildUnifiedItems hides single enabled package-extension row to avoid duplicate-looking entries", () => {
  const installedPackages = [createPackage("npm:pi-extmgr", "pi-extmgr")];
  const packageExtensions = [
    createPackageExtension(
      "pkg-ext:global:npm:pi-extmgr:src/index.ts",
      "npm:pi-extmgr",
      "src/index.ts"
    ),
  ];

  const items = buildUnifiedItems([], installedPackages, packageExtensions, new Set());

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "package");
  assert.equal(items[0]?.source, "npm:pi-extmgr");
});

void test("buildUnifiedItems keeps disabled package-extension row visible for re-enable", () => {
  const installedPackages = [createPackage("npm:pi-extmgr", "pi-extmgr")];
  const packageExtensions = [
    createPackageExtension(
      "pkg-ext:global:npm:pi-extmgr:src/index.ts",
      "npm:pi-extmgr",
      "src/index.ts",
      "disabled"
    ),
  ];

  const items = buildUnifiedItems([], installedPackages, packageExtensions, new Set());
  const types = items.map((item) => item.type);

  assert.deepEqual(types, ["package", "package-extension"]);
});

void test("buildUnifiedItems keeps multiple package-extension rows visible", () => {
  const installedPackages = [createPackage("npm:multi-ext", "multi-ext")];
  const packageExtensions = [
    {
      ...createPackageExtension(
        "pkg-ext:global:npm:multi-ext:extensions/a.ts",
        "npm:multi-ext",
        "extensions/a.ts"
      ),
      packageName: "multi-ext",
      displayName: "multi-ext/extensions/a.ts",
    },
    {
      ...createPackageExtension(
        "pkg-ext:global:npm:multi-ext:extensions/b.ts",
        "npm:multi-ext",
        "extensions/b.ts"
      ),
      packageName: "multi-ext",
      displayName: "multi-ext/extensions/b.ts",
    },
  ];

  const items = buildUnifiedItems([], installedPackages, packageExtensions, new Set());

  assert.equal(items.length, 3);
  assert.equal(items[0]?.type, "package");
  assert.equal(items[1]?.type, "package-extension");
  assert.equal(items[2]?.type, "package-extension");
});

void test("integration: pi list fixture with single-entry npm packages does not render duplicate extension rows", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-"));

  try {
    const extmgrRoot = join(cwd, "fixtures", "pi-extmgr");
    const shittyPromptRoot = join(cwd, "fixtures", "shitty-prompt");

    await mkdir(join(extmgrRoot, "src"), { recursive: true });
    await mkdir(join(shittyPromptRoot, "extensions"), { recursive: true });

    await writeFile(
      join(extmgrRoot, "package.json"),
      JSON.stringify({ name: "pi-extmgr", pi: { extensions: ["./src/index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(extmgrRoot, "src", "index.ts"), "// extmgr\n", "utf8");

    await writeFile(
      join(shittyPromptRoot, "package.json"),
      JSON.stringify(
        { name: "shitty-prompt", pi: { extensions: ["./extensions/index.ts"] } },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(shittyPromptRoot, "extensions", "index.ts"), "// prompt\n", "utf8");

    const listOutput = [
      "User packages:",
      `  npm:pi-extmgr@0.1.12`,
      `    ${extmgrRoot}`,
      `  npm:shitty-prompt@0.0.1`,
      `    ${shittyPromptRoot}`,
      "",
    ].join("\n");

    const installed = parseInstalledPackagesOutput(listOutput);
    const packageExtensions = await discoverPackageExtensions(installed, cwd);
    const items = buildUnifiedItems([], installed, packageExtensions, new Set());

    assert.equal(installed.length, 2);
    assert.equal(packageExtensions.length, 2);
    assert.equal(items.filter((item) => item.type === "package").length, 2);
    assert.equal(items.filter((item) => item.type === "package-extension").length, 0);
    assert.deepEqual(
      items.filter((item) => item.type === "package").map((item) => item.displayName),
      ["pi-extmgr", "shitty-prompt"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
