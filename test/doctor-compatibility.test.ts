import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  inspectInstalledPackageCompatibility,
  validateCompatibility,
} from "../src/doctor/compatibility.js";

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
