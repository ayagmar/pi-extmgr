import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProfileWithOutcome, calculateProfileDiagnostics } from "../src/commands/profile.js";
import { validateCompatibility } from "../src/doctor/compatibility.js";
import { type PackageCatalog, setPackageCatalogFactory } from "../src/packages/catalog.js";
import { planProfileApplication } from "../src/profiles/apply.js";
import { normalizeProfile, parseExternalProfile } from "../src/profiles/schema.js";
import { loadProfileSource } from "../src/profiles/source.js";
import {
  deleteNamedProfile,
  getNamedProfile,
  readProfileStore,
  saveNamedProfile,
} from "../src/profiles/store.js";
import { readReloadState } from "../src/utils/reload-state.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

async function withProfileEnvironment<T>(
  run: (root: string, cache: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-env-"));
  const cache = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-cache-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_EXTMGR_CACHE_DIR = cache;
  try {
    return await run(root, cache);
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
}

void test("strict external profile parsing rejects malformed entries and duplicate identities", () => {
  const malformed = parseExternalProfile({
    schemaVersion: 99,
    name: "team",
    packages: [
      { source: "npm:demo", scope: "global", filters: ["", 4] },
      { source: "npm:demo@1.0.0", scope: "global", checksum: "sha256:not-a-fingerprint" },
    ],
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.ok(malformed.errors.some((issue) => issue.code === "unsupported-version"));
    assert.ok(malformed.errors.some((issue) => issue.code === "invalid-filter"));
    assert.ok(malformed.errors.some((issue) => issue.code === "duplicate-package"));
    assert.ok(malformed.errors.some((issue) => issue.code === "invalid-fingerprint"));
  }
});

void test("strict profile parsing validates locked targets and Git ref syntax", () => {
  const invalid = parseExternalProfile({
    schemaVersion: 1,
    name: "targets",
    packages: [
      { source: "npm:demo@latest", scope: "global", resolution: "locked" },
      {
        source: "git:https://example.test/demo.git",
        scope: "global",
        ref: "abcdef0",
        resolution: "locked",
      },
      { source: "git:https://example.test/demo.git", scope: "global", ref: "bad ref" },
      {
        source: "git:https://example.test/demo.git@main",
        scope: "global",
        ref: "other",
      },
    ],
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(
      invalid.errors.filter((issue) => issue.code === "invalid-locked-target").length,
      2
    );
    assert.ok(invalid.errors.some((issue) => issue.code === "invalid-ref"));
    assert.ok(invalid.errors.some((issue) => issue.code === "conflicting-target"));
  }

  assert.equal(
    parseExternalProfile({
      schemaVersion: 1,
      name: "prerelease",
      packages: [
        { source: "npm:demo@1.2.3-beta.1+build.4", scope: "global", resolution: "locked" },
      ],
    }).ok,
    true
  );
});

void test("profile store treats prototype-shaped names as ordinary own keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-names-"));
  const path = join(root, "profiles.json");
  try {
    for (const name of ["__proto__", "constructor", "toString", "日本語"]) {
      await saveNamedProfile(path, normalizeProfile({ name, packages: [] }));
    }
    const store = await readProfileStore(path);
    assert.equal(getNamedProfile(store, "__proto__")?.name, "__proto__");
    assert.equal(getNamedProfile(store, "constructor")?.name, "constructor");
    assert.equal(Object.getPrototypeOf(store.profiles), null);
    await assert.rejects(
      () => saveNamedProfile(path, normalizeProfile({ name: "constructor", packages: [] })),
      /already exists/
    );
    await assert.rejects(
      () => saveNamedProfile(path, { schemaVersion: 1, name: "   ", packages: [] }),
      /must not be empty/
    );
    assert.equal(await deleteNamedProfile(path, "toString"), true);
    assert.equal(getNamedProfile(await readProfileStore(path), "toString"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile planning executes exact npm and git targets and models scope moves as updates", () => {
  const current = normalizeProfile({
    name: "current",
    packages: [
      { source: "npm:demo", scope: "global", version: "2.0.0" },
      { source: "git:https://example.test/demo.git", scope: "project", ref: "main" },
    ],
  });
  const desired = normalizeProfile({
    name: "desired",
    packages: [
      { source: "npm:demo", scope: "project", version: "1.0.0" },
      {
        source: "git:https://example.test/demo.git",
        scope: "project",
        ref: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
  });
  const plan = planProfileApplication(current, desired);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.remove.length, 0);
  assert.equal(plan.update.length, 2);
});

void test("profile application installs before obsolete removals and restores on failed replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-apply-"));
  const cache = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-cache-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_EXTMGR_CACHE_DIR = cache;
  const operations: string[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [{ source: "npm:old@1.0.0", name: "old", scope: "global" }],
    installImpl: (source) => {
      operations.push(`install:${source}`);
      if (source === "npm:new@2.0.0") throw new Error("replacement failed");
    },
    removeImpl: (source) => {
      operations.push(`remove:${source}`);
    },
  });
  try {
    const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
    const outcome = await applyProfileWithOutcome(
      normalizeProfile({
        name: "current",
        packages: [{ source: "npm:old@1.0.0", scope: "global" }],
      }),
      normalizeProfile({
        name: "target",
        packages: [{ source: "npm:new", version: "2.0.0", scope: "global" }],
      }),
      ctx,
      pi
    );
    assert.equal(outcome.applied, false);
    assert.equal(operations[0], "install:npm:new@2.0.0");
    assert.equal(operations.includes("remove:npm:old@1.0.0"), false);
    assert.equal(outcome.restored, true);
    assert.ok(outcome.restorePointId);
    assert.match(await readFile(join(cache, "profile-restore-points.json"), "utf8"), /current/);
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

void test("profile application contracts cover add/remove/versions/git/scope/filter and no-op", async () => {
  await withProfileEnvironment(async (root) => {
    const cases = [
      {
        name: "addition",
        current: [],
        desired: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        installed: [],
        expected: ["install:npm:demo@1.0.0:global"],
      },
      {
        name: "removal",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: ["remove:npm:demo@1.0.0:global"],
      },
      {
        name: "upgrade",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [{ source: "npm:demo", version: "2.0.0", scope: "global" as const }],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: ["install:npm:demo@2.0.0:global"],
      },
      {
        name: "downgrade",
        current: [{ source: "npm:demo@2.0.0", scope: "global" as const }],
        desired: [{ source: "npm:demo", version: "1.0.0", scope: "global" as const }],
        installed: [{ source: "npm:demo@2.0.0", name: "demo", scope: "global" as const }],
        expected: ["install:npm:demo@1.0.0:global"],
      },
      {
        name: "git ref",
        current: [{ source: "git:https://example.test/demo.git@main", scope: "global" as const }],
        desired: [
          {
            source: "git:https://example.test/demo.git",
            ref: "0123456789abcdef0123456789abcdef01234567",
            scope: "global" as const,
          },
        ],
        installed: [
          {
            source: "git:https://example.test/demo.git@main",
            name: "demo",
            scope: "global" as const,
          },
        ],
        expected: [
          "install:git:https://example.test/demo.git@0123456789abcdef0123456789abcdef01234567:global",
        ],
      },
      {
        name: "scope move",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [{ source: "npm:demo@1.0.0", scope: "project" as const }],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: ["install:npm:demo@1.0.0:project", "remove:npm:demo@1.0.0:global"],
      },
      {
        name: "filter-only",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [
          { source: "npm:demo@1.0.0", scope: "global" as const, filters: ["extensions/main.ts"] },
        ],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: [],
      },
      {
        name: "disable-all-entrypoints",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [{ source: "npm:demo@1.0.0", scope: "global" as const, filters: [] as string[] }],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: [],
      },
      {
        name: "no-op",
        current: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        desired: [{ source: "npm:demo@1.0.0", scope: "global" as const }],
        installed: [{ source: "npm:demo@1.0.0", name: "demo", scope: "global" as const }],
        expected: [],
        noOp: true,
      },
    ];

    for (const scenario of cases) {
      const mutations: string[] = [];
      const restoreCatalog = mockPackageCatalog({
        packages: scenario.installed,
        installImpl: (source, scope) => {
          mutations.push(`install:${source}:${scope}`);
        },
        removeImpl: (source, scope) => {
          mutations.push(`remove:${source}:${scope}`);
        },
      });
      try {
        const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
        const desiredInput = {
          schemaVersion: 1,
          name: `${scenario.name}-desired`,
          packages: scenario.desired,
        };
        const migrated =
          scenario.name === "addition" ? parseExternalProfile(desiredInput) : undefined;
        if (migrated && !migrated.ok) assert.fail("v1 migration unexpectedly failed");
        if (migrated?.ok) assert.equal(migrated.migration.migrated, true);
        const outcome = await applyProfileWithOutcome(
          normalizeProfile({ name: `${scenario.name}-current`, packages: scenario.current }),
          migrated?.ok ? migrated.profile : normalizeProfile(desiredInput),
          ctx,
          pi
        );
        assert.deepEqual(mutations, scenario.expected, scenario.name);
        assert.equal(outcome.applied, scenario.noOp !== true, scenario.name);
      } finally {
        restoreCatalog();
      }
    }
  });
});

void test("profile application resolves project-local sources from the .pi settings root", async () => {
  await withProfileEnvironment(async (root) => {
    const installedSources: string[] = [];
    const restoreCatalog = mockPackageCatalog({
      packages: [],
      installImpl: (source) => {
        installedSources.push(source);
      },
    });
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({
          name: "local",
          packages: [{ source: "../vendor/demo", scope: "project" }],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, true);
      assert.deepEqual(installedSources, [join(root, "vendor", "demo")]);
      const settings = JSON.parse(await readFile(join(root, ".pi", "settings.json"), "utf8")) as {
        packages?: unknown[];
      };
      assert.deepEqual(settings.packages, [join(root, "vendor", "demo")]);
    } finally {
      restoreCatalog();
    }
  });
});

void test("profile application detects newly requested package settings", async () => {
  await withProfileEnvironment(async (root) => {
    const restoreCatalog = mockPackageCatalog({
      packages: [
        {
          source: "npm:demo@1.0.0",
          name: "demo",
          version: "1.0.0",
          scope: "global",
        },
      ],
    });
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({
          name: "current",
          packages: [{ source: "npm:demo@1.0.0", scope: "global" }],
        }),
        normalizeProfile({
          name: "target",
          packages: [
            {
              source: "npm:demo@1.0.0",
              scope: "global",
              packageSettings: { skills: ["skills/team.md"] },
            },
          ],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, true);
      const settings = JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8")) as {
        packages?: unknown[];
      };
      assert.deepEqual(settings.packages, [
        { source: "npm:demo@1.0.0", skills: ["skills/team.md"] },
      ]);
    } finally {
      restoreCatalog();
    }
  });
});

void test("profile application preserves complete package resource settings", async () => {
  await withProfileEnvironment(async (root) => {
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({
          name: "configured",
          packages: [
            {
              source: "npm:demo@1.0.0",
              scope: "global",
              packageSettings: {
                skills: ["skills/team.md"],
                prompts: ["prompts/team.md"],
                themes: ["themes/team.json"],
              },
            },
          ],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, true);
      const settings = JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8")) as {
        packages?: unknown[];
      };
      assert.deepEqual(settings.packages, [
        {
          source: "npm:demo@1.0.0",
          skills: ["skills/team.md"],
          prompts: ["prompts/team.md"],
          themes: ["themes/team.json"],
        },
      ]);

      const cleared = await applyProfileWithOutcome(
        normalizeProfile({
          name: "current",
          packages: [
            {
              source: "npm:demo@1.0.0",
              scope: "global",
              packageSettings: {
                skills: ["skills/team.md"],
                prompts: ["prompts/team.md"],
                themes: ["themes/team.json"],
              },
            },
          ],
        }),
        normalizeProfile({
          name: "cleared",
          packages: [{ source: "npm:demo@1.0.0", scope: "global", packageSettings: {} }],
        }),
        ctx,
        pi
      );
      assert.equal(cleared.applied, true);
      const clearedSettings = JSON.parse(
        await readFile(join(root, "agent", "settings.json"), "utf8")
      ) as { packages?: unknown[] };
      assert.deepEqual(clearedSettings.packages, [{ source: "npm:demo@1.0.0" }]);
    } finally {
      restoreCatalog();
    }
  });
});

void test("profile diagnostics never reuse an installed manifest for a different target version", async () => {
  await withProfileEnvironment(async (root) => {
    const packageRoot = join(root, "installed-demo");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", engines: { node: ">=0" } }),
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
      const { ctx } = createMockHarness({ cwd: root, hasUI: false });
      const [diagnostic] = await calculateProfileDiagnostics(
        normalizeProfile({
          name: "target",
          packages: [{ source: "npm:demo", version: "2.0.0", scope: "global" }],
        }),
        ctx
      );
      assert.equal(diagnostic?.compatibility, "unknown");
      assert.ok(diagnostic?.notes.some((note) => note.includes("exact target is not installed")));
    } finally {
      restoreCatalog();
    }
  });
});

void test("malformed preflight and strict unknown diagnostics perform zero mutations", async () => {
  await withProfileEnvironment(async (root) => {
    const mutations: string[] = [];
    const restoreCatalog = mockPackageCatalog({
      packages: [],
      installImpl: (source) => {
        mutations.push(source);
      },
    });
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false, projectTrusted: true });
      const malformed = normalizeProfile({
        name: "bad",
        packages: [{ source: "npm:demo", scope: "global" }],
      });
      const malformedPackage = malformed.packages[0];
      assert.ok(malformedPackage);
      malformedPackage.scope = "invalid" as "global";
      const rejected = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        malformed,
        ctx,
        pi
      );
      assert.equal(rejected.applied, false);
      assert.deepEqual(mutations, []);

      await writeFile(
        join(root, ".pi", "extmgr-policy.json"),
        JSON.stringify({
          schemaVersion: 1,
          requireIntegrity: true,
          requireCompatibilityCheck: true,
        }),
        { flag: "w" }
      ).catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(root, ".pi"), { recursive: true });
        await writeFile(
          join(root, ".pi", "extmgr-policy.json"),
          JSON.stringify({
            schemaVersion: 1,
            requireIntegrity: true,
            requireCompatibilityCheck: true,
          })
        );
      });
      const strict = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({ name: "strict", packages: [{ source: "npm:demo", scope: "global" }] }),
        ctx,
        pi
      );
      assert.equal(strict.applied, false);
      assert.deepEqual(mutations, []);
    } finally {
      restoreCatalog();
    }
  });
});

void test("settings failure leaves an incomplete restore point and reload marker", async () => {
  await withProfileEnvironment(async (root, cache) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "settings.json"), "{ invalid", "utf8");
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({
          name: "target",
          packages: [{ source: "npm:demo@1.0.0", scope: "global" }],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, false);
      assert.equal(outcome.restored, false);
      assert.ok(
        outcome.operations?.some(
          (operation) => operation.action === "settings" && operation.status === "failed"
        )
      );
      assert.equal((await readReloadState(join(cache, "reload-required.json"))).required, true);
      assert.match(
        await readFile(join(cache, "profile-restore-points.json"), "utf8"),
        /"incomplete": true/
      );
    } finally {
      restoreCatalog();
    }
  });
});

void test("rollback refuses to claim success when an unexpected package remains", async () => {
  await withProfileEnvironment(async (root) => {
    let packages: Array<{ source: string; name: string; scope: "global" | "project" }> = [];
    const catalog: PackageCatalog = {
      listInstalledPackages: () => Promise.resolve(packages.map((pkg) => ({ ...pkg }))),
      checkForAvailableUpdates: () => Promise.resolve([]),
      install: async (source, scope) => {
        packages = [
          { source, name: "desired", scope },
          { source: "npm:unexpected@1.0.0", name: "unexpected", scope: "global" },
        ];
      },
      remove: async (source, scope) => {
        packages = packages.filter((pkg) => !(pkg.source === source && pkg.scope === scope));
      },
      update: async () => undefined,
    };
    setPackageCatalogFactory(() => catalog);
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({
          name: "target",
          packages: [{ source: "npm:desired@1.0.0", scope: "global" }],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, false);
      assert.equal(outcome.restored, false);
      assert.equal((await readReloadState()).required, true);
    } finally {
      setPackageCatalogFactory();
    }
  });
});

void test("final-state verification detects post-persist drift and rolls back", async () => {
  await withProfileEnvironment(async (root) => {
    let listCalls = 0;
    let installed = false;
    const catalog: PackageCatalog = {
      listInstalledPackages: () => {
        listCalls += 1;
        if (!installed || listCalls >= 3) return Promise.resolve([]);
        return Promise.resolve([{ source: "npm:demo@1.0.0", name: "demo", scope: "global" }]);
      },
      checkForAvailableUpdates: () => Promise.resolve([]),
      install: async () => {
        installed = true;
      },
      remove: async () => {
        installed = false;
      },
      update: async () => undefined,
    };
    setPackageCatalogFactory(() => catalog);
    try {
      const { ctx, pi } = createMockHarness({ cwd: root, hasUI: false });
      const outcome = await applyProfileWithOutcome(
        normalizeProfile({ name: "current", packages: [] }),
        normalizeProfile({
          name: "target",
          packages: [{ source: "npm:demo@1.0.0", scope: "global" }],
        }),
        ctx,
        pi
      );
      assert.equal(outcome.applied, false);
      assert.ok(
        outcome.operations?.some((operation) =>
          operation.error?.includes("Final-state verification")
        )
      );
    } finally {
      setPackageCatalogFactory();
    }
  });
});

void test("compatibility returns unknown instead of accepting complex semver ranges", () => {
  assert.equal(
    validateCompatibility({
      packageName: "demo",
      engines: { node: ">=20 <22" },
      nodeVersion: "21.0.0",
    }).node,
    "compatible"
  );
  assert.equal(
    validateCompatibility({
      packageName: "demo",
      engines: { node: ">=20 || <12" },
      nodeVersion: "21.0.0",
    }).node,
    "unknown"
  );
  assert.equal(
    validateCompatibility({
      packageName: "demo",
      engines: { node: "^20.0.0" },
      nodeVersion: "21.0.0",
    }).node,
    "incompatible"
  );
  assert.equal(
    validateCompatibility({
      packageName: "demo",
      engines: { node: "~20.1.0" },
      nodeVersion: "20.2.0",
    }).node,
    "incompatible"
  );
  for (const range of ["!=21.0.0", ">=20 nonsense", ">=20.0.0-beta.1"]) {
    assert.equal(
      validateCompatibility({
        packageName: "demo",
        engines: { node: range },
        nodeVersion: "21.0.0",
      }).node,
      "unknown"
    );
  }
});

void test("profile source loader bounds local JSON and converts GitHub blob origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-source-"));
  const originalFetch = globalThis.fetch;
  try {
    const local = join(root, "local.json");
    await writeFile(local, JSON.stringify({ schemaVersion: 1, name: "local", packages: [] }));
    const loadedLocal = await loadProfileSource(local, { cwd: root });
    assert.equal(loadedLocal.remote, false);
    await assert.rejects(
      () => loadProfileSource(local, { cwd: root, maxBytes: 8 }),
      /exceeds the 8 byte limit/
    );

    let requested = "";
    globalThis.fetch = (async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ schemaVersion: 1, name: "remote", packages: [] }), {
        status: 200,
      });
    }) as typeof fetch;
    const loadedRemote = await loadProfileSource(
      "https://github.com/org/repo/blob/0123456789abcdef0123456789abcdef01234567/team.json",
      { cwd: root }
    );
    assert.equal(
      requested,
      "https://raw.githubusercontent.com/org/repo/0123456789abcdef0123456789abcdef01234567/team.json"
    );
    assert.equal(loadedRemote.remote, true);
    assert.equal(loadedRemote.immutableOrigin, true);
    assert.deepEqual(loadedRemote.warnings, []);

    const generic = await loadProfileSource("https://example.test/profile.json", { cwd: root });
    assert.equal(generic.immutableOrigin, false);
    assert.ok(generic.warnings.some((warning) => warning.includes("not content-addressed")));

    await loadProfileSource("https://github.com/org/repo/blob/feature/team/profiles/team.json", {
      cwd: root,
    });
    assert.equal(
      requested,
      "https://raw.githubusercontent.com/org/repo/feature/team/profiles/team.json"
    );

    await loadProfileSource("https://github.com/org/repo/blob/feature%2Fteam/profile.json", {
      cwd: root,
    });
    assert.equal(requested, "https://raw.githubusercontent.com/org/repo/feature/team/profile.json");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
