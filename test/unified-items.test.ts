import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstalledPackagesOutput } from "../src/packages/discovery.js";
import type { ExtensionEntry, InstalledPackage } from "../src/types/index.js";
import { buildUnifiedItems } from "../src/ui/unified.js";

function createPackage(source: string, name: string): InstalledPackage {
  return {
    source,
    name,
    scope: "global",
  };
}

function createLocalEntry(activePath: string, displayName: string): ExtensionEntry {
  return {
    id: `global:${activePath}`,
    scope: "global",
    state: "enabled",
    activePath,
    disabledPath: `${activePath}.disabled`,
    displayName,
    summary: "local extension",
  };
}

void test("buildUnifiedItems includes local + package rows only", () => {
  const installedPackages = [createPackage("npm:pi-extmgr", "pi-extmgr")];
  const localEntries = [
    createLocalEntry("/tmp/extensions/local.ts", "~/.pi/agent/extensions/local.ts"),
  ];

  const items = buildUnifiedItems(localEntries, installedPackages, new Set());

  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.type),
    ["local", "package"]
  );
});

void test("buildUnifiedItems marks package update availability from knownUpdates", () => {
  const installedPackages = [createPackage("npm:pi-extmgr", "pi-extmgr")];

  const items = buildUnifiedItems([], installedPackages, new Set(["pi-extmgr"]));

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "package");
  assert.equal(items[0]?.updateAvailable, true);
});

void test("buildUnifiedItems omits package rows that duplicate local extension paths", () => {
  const localPath = "/tmp/vendor/demo/index.ts";
  const localEntries = [createLocalEntry(localPath, "~/.pi/agent/extensions/demo/index.ts")];
  const installedPackages: InstalledPackage[] = [
    {
      source: "npm:demo",
      name: "demo",
      scope: "global",
      resolvedPath: "/tmp/vendor/demo",
    },
  ];

  const items = buildUnifiedItems(localEntries, installedPackages, new Set());

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "local");
});

void test("integration: pi list fixture with single-entry npm packages renders package rows once", async () => {
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
    const items = buildUnifiedItems([], installed, new Set());

    assert.equal(installed.length, 2);
    assert.equal(items.filter((item) => item.type === "package").length, 2);
    assert.deepEqual(
      items.filter((item) => item.type === "package").map((item) => item.displayName),
      ["pi-extmgr", "shitty-prompt"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
