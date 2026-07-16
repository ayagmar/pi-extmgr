import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfile } from "../src/profiles/schema.js";

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
