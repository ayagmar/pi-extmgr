import assert from "node:assert/strict";
import test from "node:test";
import { splitGitRepoAndRef } from "../src/utils/package-source.js";

void test("Git source parsing preserves refs that contain path separators", () => {
  assert.deepEqual(splitGitRepoAndRef("https://github.com/example/demo.git@feature/team"), {
    repo: "https://github.com/example/demo.git",
    ref: "feature/team",
  });
  assert.deepEqual(splitGitRepoAndRef("git@github.com:example/demo.git@release/candidate"), {
    repo: "git@github.com:example/demo.git",
    ref: "release/candidate",
  });
});

void test("Git source parsing does not mistake URL user-info for a ref", () => {
  assert.deepEqual(splitGitRepoAndRef("https://user@example.com/example/demo.git"), {
    repo: "https://user@example.com/example/demo.git",
  });
});
