import assert from "node:assert/strict";
import test from "node:test";
import { applyProfile, planProfileApplication } from "../src/profiles/apply.js";
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
