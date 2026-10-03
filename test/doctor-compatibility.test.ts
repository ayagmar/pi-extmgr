import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  inspectInstalledPackageCompatibility,
  validateCompatibility,
} from "../src/doctor/compatibility.js";
import { buildPackageInfoText, clearRemotePackageInfoCache } from "../src/ui/discover/metadata.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("compatibility diagnostics reject packages requiring newer runtimes", () => {
  const diagnostic = validateCompatibility({
    packageName: "demo",
    engines: { node: ">=24" },
    requiredPi: ">=0.90",
    nodeVersion: "22.20.0",
    piVersion: "0.80.0",
  });
  assert.equal(diagnostic.node, "incompatible");
  assert.equal(diagnostic.pi, "incompatible");
  assert.equal(diagnostic.reasons.length, 2);
});

void test("installed package compatibility reports Node results and unknown Pi metadata", async () => {
  const diagnostics = await inspectInstalledPackageCompatibility([
    {
      source: "npm:demo",
      name: "demo",
      scope: "project",
      resolvedPath: "/missing/package",
    },
  ]);
  assert.equal(diagnostics[0]?.node, "unknown");
  assert.equal(diagnostics[0]?.pi, "unknown");
});

void test("installed inspection evaluates Pi engine ranges through the manifest path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-compatibility-"));
  try {
    await Promise.all(
      (
        [
          ["compatible", `>=${VERSION}`],
          ["incompatible", ">=99.0.0"],
          ["unknown", "^0.80.0 || ^0.90.0"],
        ] satisfies [string, string][]
      ).map(async ([name, range]) => {
        const packageRoot = join(root, name);
        await mkdir(packageRoot);
        await writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify({ engines: { pi: range } }),
          "utf8"
        );
      })
    );
    const diagnostics = await inspectInstalledPackageCompatibility(
      ["compatible", "incompatible", "unknown"].map((name) => ({
        source: `npm:${name}`,
        name,
        scope: "global" as const,
        resolvedPath: join(root, name),
      })),
      { piVersion: VERSION }
    );
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.pi),
      ["compatible", "incompatible", "unknown"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("missing compatibility metadata is reported as unknown", () => {
  assert.deepEqual(validateCompatibility({ packageName: "demo" }).reasons, []);
  assert.equal(validateCompatibility({ packageName: "demo" }).node, "unknown");
});

void test("caret and tilde ranges with partial versions follow npm semver", () => {
  const check = (range: string, version: string) =>
    validateCompatibility({ packageName: "demo", requiredPi: range, piVersion: version }).pi;

  assert.equal(check("~1", "1.5.0"), "compatible");
  assert.equal(check("~1", "2.0.0"), "incompatible");
  assert.equal(check("~1.2", "1.2.9"), "compatible");
  assert.equal(check("~1.2", "1.3.0"), "incompatible");
  assert.equal(check("^1", "1.9.0"), "compatible");
  assert.equal(check("^0", "0.80.0"), "compatible");
  assert.equal(check("^0", "1.0.0"), "incompatible");
  assert.equal(check("^0.0", "0.0.5"), "compatible");
  assert.equal(check("^0.0", "0.1.0"), "incompatible");
  assert.equal(check("^0.0.3", "0.0.4"), "incompatible");
  assert.equal(check("^0.80", "0.80.2"), "compatible");
  assert.equal(check("^0.80", "0.81.0"), "incompatible");
});

void test("Discover package details evaluate engines.pi against the running pi", async () => {
  const views: Record<string, string> = {
    "too-new": JSON.stringify({ version: "1.0.0", engines: { pi: ">=99.0.0" } }),
    current: JSON.stringify({ version: "1.0.0", engines: { node: ">=18", pi: `>=${VERSION}` } }),
  };
  const { pi, ctx } = createMockHarness({
    hasUI: true,
    execImpl: (_command, args) => ({
      code: 0,
      stdout: views[args[1] ?? ""] ?? "{}",
      stderr: "",
      killed: false,
    }),
  });
  try {
    assert.match(await buildPackageInfoText("too-new", ctx, pi), /Compatibility: incompatible/);
    assert.match(await buildPackageInfoText("current", ctx, pi), /Compatibility: compatible/);
  } finally {
    clearRemotePackageInfoCache();
  }
});
