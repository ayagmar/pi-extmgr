import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseItArgs,
  normalizeReleaseType,
  parseFirstRelease,
} from "../scripts/release-ci.js";

void test("normalizeReleaseType accepts valid workflow inputs", () => {
  assert.equal(normalizeReleaseType("patch"), "patch");
  assert.equal(normalizeReleaseType("minor"), "minor");
  assert.equal(normalizeReleaseType("major"), "major");
  assert.equal(normalizeReleaseType(" Minor "), "minor");
});

void test("normalizeReleaseType rejects invalid workflow inputs", () => {
  assert.throws(() => normalizeReleaseType(undefined), /Invalid RELEASE_TYPE/);
  assert.throws(() => normalizeReleaseType("preminor"), /Invalid RELEASE_TYPE/);
});

void test("parseFirstRelease handles github actions boolean strings", () => {
  assert.equal(parseFirstRelease("true"), true);
  assert.equal(parseFirstRelease("false"), false);
  assert.equal(parseFirstRelease(undefined), false);
});

void test("buildReleaseItArgs preserves the requested increment", () => {
  assert.deepEqual(buildReleaseItArgs({ releaseType: "patch", firstRelease: false }), [
    "exec",
    "release-it",
    "patch",
    "--ci",
  ]);

  assert.deepEqual(buildReleaseItArgs({ releaseType: "minor", firstRelease: true }), [
    "exec",
    "release-it",
    "minor",
    "--ci",
    "--first-release",
  ]);
});
