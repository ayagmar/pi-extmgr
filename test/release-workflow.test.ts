import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("release workflow only runs on the repository default branch", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    workflow,
    /concurrency:\n\s+group: release-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref \}\}/
  );
  assert.match(
    workflow,
    /if: \$\{\{ github\.ref_name == github\.event\.repository\.default_branch \}\}/
  );
});
