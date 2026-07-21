import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { checkProfileSource, handleProfileSubcommand } from "../src/commands/profile.js";
import { buildHelpLines } from "../src/ui/help.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("profile export writes exact installed source, scope, and version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-command-"));
  const packageRoot = join(cwd, "installed-demo");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "demo", version: "1.2.3" }),
    "utf8"
  );
  const restore = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo@^1.0.0",
        name: "demo",
        version: "^1.0.0",
        scope: "project",
        resolvedPath: packageRoot,
      },
    ],
  });
  try {
    const { ctx } = createMockHarness({ cwd });
    await handleProfileSubcommand(["export", "profile.json"], ctx);
    const profile = JSON.parse(await readFile(join(cwd, "profile.json"), "utf8")) as {
      packages: Array<{
        source: string;
        scope: string;
        version: string;
        resolution: string;
      }>;
    };
    assert.equal(profile.packages[0]?.source, "npm:demo");
    assert.equal(profile.packages[0]?.scope, "project");
    assert.equal(profile.packages[0]?.resolution, "locked");
    assert.equal(profile.packages[0]?.version, "1.2.3");
    assert.match(
      (profile.packages[0] as { manifestFingerprint?: string }).manifestFingerprint ?? "",
      /^sha256:[a-f0-9]{64}$/
    );
  } finally {
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("profile export resolves a floating git ref to the installed commit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-git-export-"));
  const packageRoot = join(cwd, "installed-git");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  const restore = mockPackageCatalog({
    packages: [
      {
        source: "git:https://github.com/example/demo.git@main",
        name: "demo",
        scope: "global",
        resolvedPath: packageRoot,
      },
    ],
  });
  try {
    const { ctx, pi } = createMockHarness({
      cwd,
      execImpl: (command, args) => {
        assert.equal(command, "git");
        assert.deepEqual(args, ["rev-parse", "HEAD"]);
        return { code: 0, stdout: `${commit}\n`, stderr: "", killed: false };
      },
    });
    await handleProfileSubcommand(["export", "profile.json"], ctx, pi);
    const profile = JSON.parse(await readFile(join(cwd, "profile.json"), "utf8")) as {
      packages: Array<{ source: string; ref: string; resolution: string }>;
    };
    assert.equal(profile.packages[0]?.source, "git:https://github.com/example/demo.git");
    assert.equal(profile.packages[0]?.ref, commit);
    assert.equal(profile.packages[0]?.resolution, "locked");
  } finally {
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("profile import --name supplies a missing document name", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-import-"));
  const cache = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-import-cache-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_EXTMGR_CACHE_DIR = cache;
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  try {
    const source = join(root, "profile.json");
    await writeFile(source, JSON.stringify({ schemaVersion: 1, packages: [] }), "utf8");
    const { ctx, notifications } = createMockHarness({ cwd: root });
    await handleProfileSubcommand(["import", source, "--name", "team"], ctx);
    const stored = JSON.parse(await readFile(join(cache, "profiles.json"), "utf8")) as {
      profiles: Record<string, { name: string }>;
    };
    assert.equal(stored.profiles.team?.name, "team");
    assert.equal(notifications.length, 0);
  } finally {
    restoreCatalog();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

void test("profile check strict mode gates drift but not unverifiable optional diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-check-"));
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  try {
    const driftPath = join(root, "drift.json");
    const cleanPath = join(root, "clean.json");
    await writeFile(
      driftPath,
      JSON.stringify({
        schemaVersion: 1,
        name: "drift",
        packages: [{ source: "npm:demo@1.0.0", scope: "global" }],
      }),
      "utf8"
    );
    await writeFile(
      cleanPath,
      JSON.stringify({ schemaVersion: 1, name: "clean", packages: [] }),
      "utf8"
    );
    const { ctx } = createMockHarness({ cwd: root });

    const advisory = await checkProfileSource(driftPath, ctx);
    const strictDrift = await checkProfileSource(driftPath, ctx, { strict: true });
    const strictClean = await checkProfileSource(cleanPath, ctx, { strict: true });

    assert.equal(advisory.status, "drift");
    assert.equal(advisory.ok, true);
    assert.equal(strictDrift.status, "drift");
    assert.equal(strictDrift.ok, false);
    assert.equal(strictClean.status, "ok");
    assert.equal(strictClean.ok, true);
  } finally {
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile check strict mode rejects floating remote origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-check-origin-"));
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ schemaVersion: 1, name: "remote", packages: [] }), {
        status: 200,
      })
    )) as typeof fetch;
  try {
    const { ctx } = createMockHarness({ cwd: root });
    const result = await checkProfileSource(
      "https://raw.githubusercontent.com/org/repo/main/profile.json",
      ctx,
      { strict: true }
    );
    assert.equal(result.drift, false);
    assert.equal(result.status, "origin-warning");
    assert.equal(result.ok, false);
    assert.equal(result.originWarnings.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile check retains warnings from previously imported remote profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-check-imported-warning-"));
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  try {
    const source = join(root, "saved.json");
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 1,
        name: "saved-remote",
        packages: [],
        importMetadata: {
          origin: "https://raw.githubusercontent.com/org/repo/main/profile.json",
          warnings: ["GitHub origin uses a floating ref"],
        },
      }),
      "utf8"
    );
    const { ctx } = createMockHarness({ cwd: root });
    const result = await checkProfileSource(source, ctx, { strict: true });
    assert.equal(result.status, "origin-warning");
    assert.equal(result.ok, false);
    assert.deepEqual(result.originWarnings, ["GitHub origin uses a floating ref"]);
  } finally {
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile check fails on a confirmed compatibility failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-check-incompatible-"));
  const packageRoot = join(root, "installed-demo");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", engines: { node: ">999" } }),
    "utf8"
  );
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo@1.0.0",
        name: "demo",
        version: "1.0.0",
        scope: "global",
        resolvedPath: packageRoot,
      },
    ],
  });
  try {
    const source = join(root, "profile.json");
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 1,
        name: "incompatible",
        packages: [
          {
            source: "npm:demo",
            version: "1.0.0",
            resolution: "locked",
            scope: "global",
          },
        ],
      }),
      "utf8"
    );
    const { ctx } = createMockHarness({ cwd: root });
    const result = await checkProfileSource(source, ctx);
    assert.equal(result.drift, false);
    assert.equal(result.status, "diagnostic-failure");
    assert.equal(result.ok, false);
    assert.deepEqual(result.compatibilityFailed, ["npm:demo@1.0.0 (global)"]);
  } finally {
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile check --json emits one deterministic machine-readable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-check-json-"));
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    const source = join(root, "profile.json");
    await writeFile(
      source,
      JSON.stringify({ schemaVersion: 1, name: "clean", packages: [] }),
      "utf8"
    );
    const { ctx } = createMockHarness({ cwd: root });
    await handleProfileSubcommand(["check", source, "--json", "--strict"], ctx);

    assert.equal(output.length, 1);
    const result = JSON.parse(output[0] ?? "") as { ok: boolean; status: string; strict: boolean };
    assert.deepEqual(result, { ...result, ok: true, status: "ok", strict: true });

    await writeFile(source, JSON.stringify({ schemaVersion: 1, packages: "bad" }), "utf8");
    await handleProfileSubcommand(["check", source, "--json"], ctx);
    assert.equal(output.length, 2);
    const invalid = JSON.parse(output[1] ?? "") as { ok: boolean; status: string; valid: boolean };
    assert.deepEqual(invalid, { ...invalid, ok: false, status: "invalid", valid: false });
  } finally {
    console.log = originalLog;
    restoreCatalog();
    await rm(root, { recursive: true, force: true });
  }
});

void test("manager help stays compact and width-safe", () => {
  const lines = buildHelpLines();
  assert.ok(lines.includes("Extensions Manager Help"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 88));
  assert.ok(lines.some((line) => line.includes("Bulk actions")));
  assert.ok(lines.some((line) => line.includes("Reload required")));
});
