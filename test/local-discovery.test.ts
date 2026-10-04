import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverExtensions, setExtensionState } from "../src/extensions/discovery.js";

void test("setExtensionState preserves existing rename destinations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-state-"));
  const activePath = join(cwd, "demo.ts");
  const disabledPath = `${activePath}.disabled`;
  try {
    await writeFile(activePath, "active", "utf8");
    let result = await setExtensionState({ activePath, disabledPath }, "disabled");
    assert.deepEqual(result, { ok: true });
    assert.equal(await readFile(disabledPath, "utf8"), "active");
    result = await setExtensionState({ activePath, disabledPath }, "enabled");
    assert.deepEqual(result, { ok: true });
    assert.equal(await readFile(activePath, "utf8"), "active");

    await writeFile(activePath, "replacement", "utf8");
    result = await setExtensionState({ activePath, disabledPath }, "disabled");
    assert.deepEqual(result, { ok: true });
    await writeFile(activePath, "conflicting active", "utf8");
    result = await setExtensionState({ activePath, disabledPath }, "disabled");
    assert.equal(result.ok, false);
    assert.match(result.error, /destination already exists/);
    assert.equal(await readFile(activePath, "utf8"), "conflicting active");
    assert.equal(await readFile(disabledPath, "utf8"), "replacement");
    await rm(activePath);
    await rm(disabledPath);
    result = await setExtensionState({ activePath, disabledPath }, "disabled");
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverExtensions includes manifest-declared local entrypoints, including disabled files", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "pi-extmgr-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-local-discovery-"));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;

    const pkgRoot = join(cwd, ".pi", "extensions", "demo-pkg");
    await mkdir(join(pkgRoot, "extensions"), { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo-pkg",
          pi: { extensions: ["./custom.ts", "./extensions/*.ts"] },
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(pkgRoot, "custom.ts"), "// custom entrypoint\n", "utf8");
    await writeFile(
      join(pkgRoot, "extensions", "queue.ts.disabled"),
      "// disabled entrypoint\n",
      "utf8"
    );

    const entries = await discoverExtensions(cwd, { projectTrusted: true });
    const customEntry = entries.find((entry) => entry.displayName.endsWith("demo-pkg/custom.ts"));
    const disabledEntry = entries.find((entry) =>
      entry.displayName.endsWith("demo-pkg/extensions/queue.ts")
    );

    assert.equal(customEntry?.scope, "project");
    assert.equal(customEntry?.state, "enabled");
    assert.equal(disabledEntry?.scope, "project");
    assert.equal(disabledEntry?.state, "disabled");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tempHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverExtensions skips an untrusted project's .pi/extensions, which pi does not load", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-untrusted-discovery-"));
  try {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "extensions", "project-only.ts"), "// project\n", "utf8");

    const trusted = await discoverExtensions(cwd, { projectTrusted: true });
    assert.ok(trusted.some((entry) => entry.displayName.endsWith("project-only.ts")));

    const untrusted = await discoverExtensions(cwd, { projectTrusted: false });
    assert.ok(untrusted.every((entry) => entry.scope !== "project"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("discoverExtensions lists symlinked extension files and directories like pi", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-local-symlinks-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-extmgr-local-symlink-targets-"));
  try {
    const extensionsDir = join(cwd, ".pi", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(outside, "linked.ts"), "// linked file\n", "utf8");
    await writeFile(join(outside, "disabled.ts.disabled"), "// linked disabled\n", "utf8");
    await mkdir(join(outside, "linked-dir"));
    await writeFile(join(outside, "linked-dir", "index.ts"), "// linked dir\n", "utf8");
    await symlink(join(outside, "linked.ts"), join(extensionsDir, "linked.ts"));
    await symlink(
      join(outside, "disabled.ts.disabled"),
      join(extensionsDir, "disabled.ts.disabled")
    );
    await symlink(join(outside, "linked-dir"), join(extensionsDir, "linked-dir"), "dir");
    await symlink(join(outside, "missing.ts"), join(extensionsDir, "broken.ts"));

    const entries = await discoverExtensions(cwd, { projectTrusted: true });
    const byName = new Map(entries.map((entry) => [entry.displayName, entry]));

    assert.equal(byName.get(".pi/extensions/linked.ts")?.state, "enabled");
    assert.equal(byName.get(".pi/extensions/disabled.ts")?.state, "disabled");
    assert.equal(byName.get(".pi/extensions/linked-dir/index.ts")?.state, "enabled");
    assert.equal(byName.has(".pi/extensions/broken.ts"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
