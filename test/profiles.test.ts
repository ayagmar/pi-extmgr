import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProfile, planProfileApplication } from "../src/profiles/apply.js";
import {
  compareProfiles,
  loadProjectProfilePolicy,
  validateProfilePolicy,
} from "../src/profiles/compare.js";
import { normalizeProfile } from "../src/profiles/schema.js";
import {
  deleteNamedProfile,
  readProfileStore,
  saveNamedProfile,
  writeProfileStore,
} from "../src/profiles/store.js";

void test("profile application produces a dry-run plan without mutating state", async () => {
  const current = normalizeProfile({
    name: "current",
    packages: [{ source: "npm:old", scope: "global" }],
  });
  const desired = normalizeProfile({
    name: "desired",
    packages: [{ source: "npm:new", scope: "project" }],
  });
  let applied = false;
  const plan = await applyProfile(current, desired, {
    dryRun: true,
    apply: async () => {
      applied = true;
    },
  });
  assert.equal(plan.add[0]?.source, "npm:new");
  assert.equal(plan.remove[0]?.source, "npm:old");
  assert.equal(applied, false);
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
  const scopePlan = compareProfiles(left, right);
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
      () =>
        writeProfileStore(path, unsupported as unknown as Parameters<typeof writeProfileStore>[1]),
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
