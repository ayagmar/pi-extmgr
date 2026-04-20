import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSummary } from "../src/utils/fs.js";

void test("readSummary flattens multi-line template literal descriptions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-fs-"));
  const filePath = join(cwd, "multi-line-description.ts");

  try {
    await writeFile(
      filePath,
      [
        "export const tool = {",
        "  description: `Delegate to subagents or manage agent definitions.",
        "",
        "EXECUTION (use exactly ONE mode):",
        "• SINGLE: { agent, task } - one task`,",
        "};",
      ].join("\n"),
      "utf8"
    );

    const summary = await readSummary(filePath);

    assert.equal(summary.includes("\n"), false);
    assert.match(summary, /^Delegate to subagents or manage agent definitions\. EXECUTION/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
