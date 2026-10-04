import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

void test("toggling an extension in a symlinked directory leaves the link target untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-local-symlink-toggle-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-extmgr-local-symlink-checkout-"));
  try {
    const extensionsDir = join(cwd, ".pi", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await mkdir(join(outside, "my-ext"));
    await writeFile(join(outside, "my-ext", "index.ts"), "// under development\n", "utf8");
    await symlink(join(outside, "my-ext"), join(extensionsDir, "my-ext"), "dir");

    const entries = await discoverExtensions(cwd, { projectTrusted: true });
    const linked = entries.find((entry) => entry.displayName === ".pi/extensions/my-ext/index.ts");
    assert.ok(linked);
    assert.equal(linked.linkTarget, await realpath(join(outside, "my-ext")));

    const result = await setExtensionState(linked, "disabled");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /symlinked extension directory/);
    assert.equal(existsSync(join(outside, "my-ext", "index.ts")), true);
    assert.equal(existsSync(join(outside, "my-ext", "index.ts.disabled")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function withAgentDir<T>(run: (agentDir: string, cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-local-overrides-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    return await run(agentDir, cwd);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function readGlobalSettings(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

void test("an extension disabled in settings, as pi config does, is reported disabled", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    await writeFile(join(agentDir, "extensions", "foo.ts"), "// foo\n", "utf8");
    await writeFile(join(agentDir, "extensions", "bar.ts"), "// bar\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["-extensions/foo.ts", "-builtin:x"] }),
      "utf8"
    );

    const entries = await discoverExtensions(cwd, { projectTrusted: false });
    const byName = new Map(entries.map((entry) => [basename(entry.activePath), entry]));
    assert.equal(byName.get("foo.ts")?.state, "disabled");
    assert.equal(byName.get("foo.ts")?.settingsDisabled, true);
    assert.equal(byName.get("bar.ts")?.state, "enabled");
  });
});

void test("enabling a settings-disabled extension removes only its override", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(fooPath, "// foo\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: ["-extensions/foo.ts", "-builtin:x", "+extensions/other.ts"],
        packages: [{ source: "npm:demo", extensions: ["-a.ts"] }],
        quietStartup: true,
      }),
      "utf8"
    );

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.ok(foo);
    const result = await setExtensionState(foo, "enabled", { cwd, projectTrusted: false });
    assert.deepEqual(result, { ok: true });

    const settings = await readGlobalSettings(agentDir);
    assert.deepEqual(settings.extensions, ["-builtin:x", "+extensions/other.ts"]);
    assert.deepEqual(settings.packages, [{ source: "npm:demo", extensions: ["-a.ts"] }]);
    assert.equal(settings.quietStartup, true);
    assert.equal(existsSync(fooPath), true);
    assert.equal(existsSync(`${fooPath}.disabled`), false);

    const after = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.equal(after?.state, "enabled");
  });
});

void test("enabling a renamed extension also clears a stale settings override", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(`${fooPath}.disabled`, "// foo\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: [`-${fooPath}`, "-builtin:x"] }),
      "utf8"
    );

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.equal(foo?.state, "disabled");
    assert.ok(foo);
    assert.deepEqual(await setExtensionState(foo, "enabled", { cwd, projectTrusted: false }), {
      ok: true,
    });
    assert.equal(existsSync(fooPath), true);
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, ["-builtin:x"]);
  });
});

void test("an extension disabled by a settings glob is not silently reported enabled", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(fooPath, "// foo\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["!extensions/*.ts"] }),
      "utf8"
    );

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.equal(foo?.state, "disabled");
    assert.ok(foo);
    const result = await setExtensionState(foo, "enabled", { cwd, projectTrusted: false });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /pattern in the "extensions" setting/);
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, ["!extensions/*.ts"]);
  });
});

void test("project overrides are read and cleared in the project settings", async () => {
  await withAgentDir(async (_agentDir, cwd) => {
    const localPath = join(cwd, ".pi", "extensions", "local.ts");
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, "// local\n", "utf8");
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["-./extensions/local.ts", "-builtin:y"] }),
      "utf8"
    );

    const local = (await discoverExtensions(cwd, { projectTrusted: true })).find(
      (entry) => entry.activePath === localPath
    );
    assert.equal(local?.state, "disabled");
    assert.ok(local);
    assert.deepEqual(await setExtensionState(local, "enabled", { cwd, projectTrusted: true }), {
      ok: true,
    });
    const settings = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")) as {
      extensions?: string[];
    };
    assert.deepEqual(settings.extensions, ["-builtin:y"]);
  });
});

void test("disable then enable keeps a `+path` that lets the file through a `!glob`", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(fooPath, "// foo\n", "utf8");
    const extensions = ["!extensions/*.ts", "+extensions/foo.ts"];
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions }), "utf8");
    const find = async () =>
      (await discoverExtensions(cwd, { projectTrusted: false })).find(
        (entry) => entry.activePath === fooPath
      );

    const before = await find();
    assert.equal(before?.state, "enabled");
    assert.ok(before);
    assert.deepEqual(await setExtensionState(before, "disabled", { cwd, projectTrusted: false }), {
      ok: true,
    });
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, extensions);

    const disabled = await find();
    assert.equal(disabled?.state, "disabled");
    assert.ok(disabled);
    assert.deepEqual(await setExtensionState(disabled, "enabled", { cwd, projectTrusted: false }), {
      ok: true,
    });
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, extensions);
    const after = await find();
    assert.equal(after?.state, "enabled");
    assert.equal(after?.settingsDisabled, undefined);
  });
});

void test("enabling a renamed extension that a `!glob` still blocks fails and keeps it disabled", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(`${fooPath}.disabled`, "// foo\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["!extensions/*.ts"] }),
      "utf8"
    );

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.equal(foo?.state, "disabled");
    assert.equal(foo?.settingsDisabled, undefined);
    assert.ok(foo);
    const result = await setExtensionState(foo, "enabled", { cwd, projectTrusted: false });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /pattern in the "extensions" setting/);
    assert.equal(existsSync(fooPath), false);
    assert.equal(existsSync(`${fooPath}.disabled`), true);
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, ["!extensions/*.ts"]);
  });
});

void test("enabling an extension blocked by both `-path` and a `!glob` fails without editing settings", async () => {
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    await writeFile(fooPath, "// foo\n", "utf8");
    const extensions = ["-extensions/foo.ts", "!extensions/*.ts"];
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions }), "utf8");

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.equal(foo?.settingsDisabled, true);
    assert.ok(foo);
    const result = await setExtensionState(foo, "enabled", { cwd, projectTrusted: false });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /pattern in the "extensions" setting/);
    assert.equal(existsSync(fooPath), true);
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, extensions);
  });
});

void test("a failed settings write while enabling undoes the rename so a retry works", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores file permissions");
    return;
  }
  await withAgentDir(async (agentDir, cwd) => {
    const fooPath = join(agentDir, "extensions", "foo.ts");
    const settingsPath = join(agentDir, "settings.json");
    await writeFile(`${fooPath}.disabled`, "// foo\n", "utf8");
    await writeFile(settingsPath, JSON.stringify({ extensions: ["-extensions/foo.ts"] }), "utf8");
    await chmod(settingsPath, 0o444);

    const foo = (await discoverExtensions(cwd, { projectTrusted: false })).find(
      (entry) => entry.activePath === fooPath
    );
    assert.ok(foo);
    const failed = await setExtensionState(foo, "enabled", { cwd, projectTrusted: false });
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? "" : failed.error, /Could not update Pi settings/);
    assert.equal(existsSync(fooPath), false);
    assert.equal(existsSync(`${fooPath}.disabled`), true);

    await chmod(settingsPath, 0o644);
    assert.deepEqual(await setExtensionState(foo, "enabled", { cwd, projectTrusted: false }), {
      ok: true,
    });
    assert.equal(existsSync(fooPath), true);
    assert.deepEqual((await readGlobalSettings(agentDir)).extensions, []);
  });
});
