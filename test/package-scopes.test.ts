import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getPackageCatalog, suppressPackageManagerOutput } from "../src/packages/catalog.js";
import { comparePackageScopes, movePackageBetweenScopes } from "../src/packages/scopes.js";

void test("TUI output shim drains captured streams and preserves child errors", async () => {
  const events: string[] = [];
  const child = {
    stdout: { resume: () => events.push("stdout") },
    stderr: { resume: () => events.push("stderr") },
    once: (event: string, listener: (error: Error) => void) => {
      if (event === "error") listener(new Error("child failed"));
      return child;
    },
  };
  const runners = {
    runCommand: () => Promise.resolve(),
    runCommandCapture: () => Promise.resolve(""),
  };
  const manager = {
    spawnCommand: () => {
      throw new Error("inherited output should not be used");
    },
    spawnCaptureCommand: () => child,
    ...runners,
  };

  suppressPackageManagerOutput(manager);
  const result = (manager.spawnCommand as (...args: unknown[]) => typeof child)("git", []);
  result.once("error", (error: Error) => events.push(error.message));
  assert.deepEqual(events, ["stdout", "stderr", "child failed"]);

  assert.throws(
    () => suppressPackageManagerOutput({ spawnCaptureCommand: () => child, ...runners }),
    /spawnCommand is unavailable/
  );
  assert.throws(
    () => suppressPackageManagerOutput({ spawnCommand: () => child, ...runners }),
    /spawnCaptureCommand is unavailable/
  );
  assert.throws(
    () =>
      suppressPackageManagerOutput({
        spawnCommand: () => child,
        spawnCaptureCommand: () => child,
        runCommandCapture: runners.runCommandCapture,
      }),
    /runCommand is unavailable/
  );
  assert.throws(
    () =>
      suppressPackageManagerOutput({
        spawnCommand: () => child,
        spawnCaptureCommand: () => child,
        runCommand: runners.runCommand,
      }),
    /runCommandCapture is unavailable/
  );

  const invalidChildManager = {
    spawnCommand: () => child,
    spawnCaptureCommand: () => undefined,
    ...runners,
  };
  suppressPackageManagerOutput(invalidChildManager);
  assert.throws(() => invalidChildManager.spawnCommand(), /invalid child process/);
});

void test("TUI output shim keeps the npm error text when pi's install fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-suppressed-install-"));
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    // Every command pi spawns prints an npm-style reason to stderr and fails.
    (manager as unknown as { spawnCaptureCommand: () => unknown }).spawnCaptureCommand = () =>
      spawn(
        process.execPath,
        ["-e", "process.stderr.write('npm ERR! 404 Not Found - typo-pkg'); process.exit(1)"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    suppressPackageManagerOutput(manager);

    await assert.rejects(manager.install("npm:typo-pkg"), /failed with code 1: npm ERR! 404/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("TUI output shim keeps only the end of very long command errors", async () => {
  const manager = {
    spawnCommand: () => ({}),
    spawnCaptureCommand: () => ({}),
    runCommand: () => Promise.resolve(),
    runCommandCapture: () =>
      Promise.reject(new Error(`npm install failed with code 1: ${"x".repeat(10_000)}TAIL`)),
  };
  suppressPackageManagerOutput(manager);
  await assert.rejects(manager.runCommand(), (error: Error) => {
    assert.ok(error.message.length <= 4001);
    assert.ok(error.message.endsWith("TAIL"));
    return true;
  });
});

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

    const result = await movePackageBetweenScopes("npm:demo@1.2.3", "global", "project", cwd, true);
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
    const result = await movePackageBetweenScopes("npm:demo@1.0.0", "global", "project", cwd, true);
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
    const moved = await movePackageBetweenScopes("npm:demo", "global", "project", cwd, true);
    assert.equal(moved.moved, false);
    assert.match(moved.conflict ?? "", /Package scope move refused/);
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), "{ invalid");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

void test("package catalog lists project packages first with pi's installed paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-catalog-list-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi", "local-pkg"), { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:demo"] }),
      "utf8"
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: [{ source: "npm:demo", extensions: [] }, "./local-pkg"] }),
      "utf8"
    );

    const catalog = getPackageCatalog(cwd, true);
    const all = await catalog.listInstalledPackages({ dedupe: false });
    assert.deepEqual(
      all.map((pkg) => `${pkg.scope}:${pkg.source}`),
      ["project:npm:demo", "project:./local-pkg", "global:npm:demo"]
    );
    assert.equal(
      all.find((pkg) => pkg.source === "./local-pkg")?.resolvedPath,
      join(cwd, ".pi", "local-pkg")
    );

    const effective = await catalog.listInstalledPackages();
    assert.deepEqual(
      effective.map((pkg) => `${pkg.scope}:${pkg.source}`),
      ["project:npm:demo", "project:./local-pkg"]
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

void test("package catalog install and remove persist the settings entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-catalog-persist-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const localPackage = join(root, "local-package");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(localPackage, { recursive: true });
    await writeFile(join(localPackage, "index.ts"), "export default () => {};\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:keep"], quietStartup: true }),
      "utf8"
    );
    const readSettings = async () =>
      JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
        packages?: unknown[];
        quietStartup?: boolean;
      };

    await getPackageCatalog(cwd).install(localPackage, "global");
    // pi stores local sources relative to the settings directory.
    assert.deepEqual((await readSettings()).packages, ["npm:keep", "../local-package"]);

    await getPackageCatalog(cwd).remove(localPackage, "global");
    const settings = await readSettings();
    assert.deepEqual(settings.packages, ["npm:keep"]);
    assert.equal(settings.quietStartup, true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
