import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planProfileApplication } from "../src/profiles/apply.js";
import { loadProjectProfilePolicy, validateProfilePolicy } from "../src/profiles/compare.js";
import { duplicateProfile, renameProfile, saveProfile } from "../src/profiles/management.js";
import { getEffectivePackageSource, normalizeProfile } from "../src/profiles/schema.js";
import { deleteNamedProfile, readProfileStore, saveNamedProfile } from "../src/profiles/store.js";

void test("profile planning reports additions and removals across scopes", () => {
  const current = normalizeProfile({
    name: "current",
    packages: [{ source: "npm:old", scope: "global" }],
  });
  const desired = normalizeProfile({
    name: "desired",
    packages: [{ source: "npm:new", scope: "project" }],
  });
  const plan = planProfileApplication(current, desired);
  assert.equal(plan.add[0]?.source, "npm:new");
  assert.equal(plan.remove[0]?.source, "npm:old");
});

void test("profile plans treat equivalent embedded and declared targets as equal", () => {
  const current = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
  });
  const desired = normalizeProfile({
    packages: [{ source: "npm:demo@1.0.0", scope: "global" }],
  });
  assert.equal(planProfileApplication(current, desired).update.length, 0);
});

void test("profile plans identify exact package state changes", () => {
  const current = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
  });
  const desired = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", version: "2.0.0" }],
  });
  assert.equal(planProfileApplication(current, desired).update.length, 1);
});

void test("profile plans preserve omitted package settings but honor explicit clearing", () => {
  const current = normalizeProfile({
    packages: [
      {
        source: "npm:demo",
        scope: "global",
        packageSettings: { skills: ["skills/team.md"] },
      },
    ],
  });
  const preserve = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global" }],
  });
  const clear = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", packageSettings: {} }],
  });

  assert.equal(planProfileApplication(current, preserve).update.length, 0);
  assert.equal(planProfileApplication(current, clear).update.length, 1);
});

void test("profile plans distinguish default filters from explicitly disabling every entrypoint", () => {
  const defaults = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global" }],
  });
  const disabled = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", filters: [] }],
  });

  assert.equal(planProfileApplication(defaults, disabled).update.length, 1);
  assert.equal(planProfileApplication(disabled, defaults).update.length, 1);
  assert.equal(planProfileApplication(disabled, disabled).update.length, 0);
});

void test("profile comparison and policy validation expose actionable differences", () => {
  const left = normalizeProfile({ packages: [{ source: "npm:demo", scope: "global" }] });
  const right = normalizeProfile({ packages: [{ source: "npm:demo", scope: "project" }] });
  const scopePlan = planProfileApplication(left, right);
  assert.equal(scopePlan.update.length, 1);
  assert.equal(scopePlan.update[0]?.from.scope, "global");
  assert.equal(scopePlan.update[0]?.to.scope, "project");
  assert.equal(
    validateProfilePolicy(right, { allowedScopes: ["global"], requireChecksums: true }).length,
    2
  );
});

void test("named profiles persist atomically and can be deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-store-"));
  const path = join(root, "profiles.json");
  try {
    await saveNamedProfile(path, normalizeProfile({ name: " team ", packages: [] }));
    assert.equal((await readProfileStore(path)).profiles.team?.name, "team");
    assert.equal(await deleteNamedProfile(path, "team"), true);
    assert.equal(Object.keys((await readProfileStore(path)).profiles).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("concurrent named profile saves retain every update", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-store-race-"));
  const path = join(root, "profiles.json");
  try {
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        saveNamedProfile(path, normalizeProfile({ name: `team-${index}`, packages: [] }))
      )
    );
    const names = Object.keys((await readProfileStore(path)).profiles).sort();
    assert.deepEqual(names, Array.from({ length: 24 }, (_, index) => `team-${index}`).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile rename and duplicate are queued atomic read-modify-writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-lifecycle-"));
  const path = join(root, "profiles.json");
  try {
    await saveProfile(
      normalizeProfile({
        name: "source",
        packages: [{ source: "npm:demo", scope: "project" }],
      }),
      "source",
      { storePath: path, replace: false }
    );

    await Promise.all([
      renameProfile("source", "renamed", { storePath: path, replace: false }),
      saveProfile(normalizeProfile({ name: "concurrent", packages: [] }), "concurrent", {
        storePath: path,
        replace: false,
      }),
    ]);
    await Promise.all([
      duplicateProfile("renamed", "copy", { storePath: path, replace: false }),
      saveProfile(normalizeProfile({ name: "also-concurrent", packages: [] }), "also-concurrent", {
        storePath: path,
        replace: false,
      }),
    ]);

    const profiles = (await readProfileStore(path)).profiles;
    assert.deepEqual(Object.keys(profiles).sort(), [
      "also-concurrent",
      "concurrent",
      "copy",
      "renamed",
    ]);
    assert.equal(profiles.source, undefined);
    assert.equal(profiles.renamed?.name, "renamed");
    assert.equal(profiles.copy?.name, "copy");
    assert.deepEqual(profiles.copy?.packages, profiles.renamed?.packages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile lifecycle collisions preserve sources and destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-collision-"));
  const path = join(root, "profiles.json");
  try {
    await saveNamedProfile(
      path,
      normalizeProfile({ name: "source", packages: [{ source: "npm:source", scope: "global" }] })
    );
    await saveNamedProfile(
      path,
      normalizeProfile({
        name: "destination",
        packages: [{ source: "npm:destination", scope: "global" }],
      })
    );

    await assert.rejects(
      () => renameProfile("source", "destination", { storePath: path, replace: false }),
      /already exists/
    );
    await assert.rejects(
      () => duplicateProfile("source", "destination", { storePath: path, replace: false }),
      /already exists/
    );

    const profiles = (await readProfileStore(path)).profiles;
    assert.equal(profiles.source?.packages[0]?.source, "npm:source");
    assert.equal(profiles.destination?.packages[0]?.source, "npm:destination");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile lifecycle supports prototype-shaped names and rejects missing sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-prototype-names-"));
  const path = join(root, "profiles.json");
  try {
    await saveProfile(normalizeProfile({ name: "__proto__", packages: [] }), "__proto__", {
      storePath: path,
      replace: false,
    });
    await renameProfile("__proto__", "constructor", { storePath: path, replace: false });
    await duplicateProfile("constructor", "toString", { storePath: path, replace: false });
    await assert.rejects(
      () => renameProfile("missing", "other", { storePath: path, replace: false }),
      /not found/
    );
    await assert.rejects(
      () => duplicateProfile("missing", "other", { storePath: path, replace: false }),
      /not found/
    );

    const profiles = (await readProfileStore(path)).profiles;
    assert.deepEqual(Object.keys(profiles).sort(), ["constructor", "toString"]);
    assert.equal(profiles.constructor?.name, "constructor");
    assert.equal(profiles.toString?.name, "toString");
    assert.equal(Object.hasOwn(profiles, "other"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile writes refuse malformed or unknown-version stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-store-invalid-"));
  const path = join(root, "profiles.json");
  try {
    await writeFile(path, "{ invalid", "utf8");
    await assert.rejects(
      () => saveNamedProfile(path, normalizeProfile({ name: "team", packages: [] })),
      /Unable to read profile store/
    );
    assert.equal(await readFile(path, "utf8"), "{ invalid");

    const unsupported = { version: 99, profiles: {} };
    await writeFile(path, JSON.stringify(unsupported), "utf8");
    await assert.rejects(
      () => saveNamedProfile(path, normalizeProfile({ name: "team", packages: [] })),
      /Unsupported or malformed profile store/
    );
    await assert.rejects(
      () => deleteNamedProfile(path, "team"),
      /Unsupported or malformed profile store/
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), unsupported);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("project policy loading rejects malformed policies and validates requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-policy-"));
  try {
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify({ schemaVersion: 1, allowedScopes: ["project"], requireChecksums: true }),
      "utf8"
    );
    const policy = await loadProjectProfilePolicy(root, join(root, "policy.json"));
    assert.equal(
      validateProfilePolicy(
        normalizeProfile({ packages: [{ source: "npm:demo", scope: "global" }] }),
        policy ?? {}
      ).length,
      2
    );
    await writeFile(join(root, "bad.json"), "{invalid", "utf8");
    await assert.rejects(() => loadProjectProfilePolicy(root, join(root, "bad.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("profile schema preserves exact package versions, refs, filters, scopes, and checksums", () => {
  const profile = normalizeProfile({
    schemaVersion: 99,
    name: " team ",
    packages: [
      {
        source: " npm:demo ",
        scope: "project",
        version: "1.2.3",
        ref: "sha256:abc",
        filters: ["+extensions/main.ts", "-extensions/legacy.ts"],
        checksum: "sha256:deadbeef",
      },
    ],
    checks: { compatibility: true, provenance: true },
  });
  assert.deepEqual(profile, {
    schemaVersion: 1,
    name: "team",
    packages: [
      {
        source: "npm:demo",
        scope: "project",
        version: "1.2.3",
        ref: "sha256:abc",
        filters: ["+extensions/main.ts", "-extensions/legacy.ts"],
        checksum: "sha256:deadbeef",
      },
    ],
    checks: { compatibility: true, provenance: true },
  });
});

void test("profile git sources resolve to spellings pi can install", () => {
  assert.equal(
    getEffectivePackageSource({
      source: "git+https://github.com/user/repo.git",
      scope: "global",
      ref: "v1.2.0",
    }),
    "git:https://github.com/user/repo.git@v1.2.0"
  );
  assert.equal(
    getEffectivePackageSource({
      source: "git:https://github.com/user/repo.git@main",
      scope: "global",
    }),
    "git:https://github.com/user/repo.git@main"
  );
  assert.equal(
    getEffectivePackageSource({ source: "git@github.com:user/repo.git", scope: "global" }),
    "git:git@github.com:user/repo.git"
  );
  assert.equal(
    getEffectivePackageSource({
      source: "https://github.com/user/repo",
      scope: "global",
      ref: "v2",
    }),
    "https://github.com/user/repo@v2"
  );
});
