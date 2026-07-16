import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProfile, planProfileApplication } from "../src/profiles/apply.js";
import {
  compareProfiles,
  loadProjectProfilePolicy,
  validateProfilePolicy,
} from "../src/profiles/compare.js";
import { deleteNamedProfile, readProfileStore, saveNamedProfile } from "../src/profiles/store.js";
import { normalizeProfile } from "../src/profiles/schema.js";

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

void test("profile plans identify exact package state changes", () => {
  const current = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", version: "1.0.0" }],
  });
  const desired = normalizeProfile({
    packages: [{ source: "npm:demo", scope: "global", version: "2.0.0" }],
  });
  assert.equal(planProfileApplication(current, desired).update.length, 1);
});

void test("profile comparison and policy validation expose actionable differences", () => {
  const left = normalizeProfile({ packages: [{ source: "npm:demo", scope: "global" }] });
  const right = normalizeProfile({ packages: [{ source: "npm:demo", scope: "project" }] });
  assert.equal(compareProfiles(left, right).add.length, 1);
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
