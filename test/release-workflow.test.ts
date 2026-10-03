import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readReleaseWorkflow(): Promise<string> {
  return readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
}

void test("release workflow serializes runs without cancelling an in-flight release", async () => {
  const workflow = await readReleaseWorkflow();

  assert.match(
    workflow,
    /concurrency:\n\s+group: release-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false/
  );
});

void test("release workflow only runs on the repository default branch", async () => {
  const workflow = await readReleaseWorkflow();

  assert.match(
    workflow,
    /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
  );
});

void test("release workflow runs the full check before publishing via npm trusted publishing", async () => {
  const workflow = await readReleaseWorkflow();

  assert.match(workflow, /id-token: write/);
  const checkIndex = workflow.indexOf("run: pnpm run check");
  const publishIndex = workflow.search(/^\s+npm publish /m);
  assert.ok(checkIndex > -1, "release workflow must run pnpm run check");
  assert.ok(publishIndex > checkIndex, "npm publish must run after pnpm run check");
});
