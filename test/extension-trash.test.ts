import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveToExtensionTrash, undoExtensionTrash } from "../src/extensions/trash.js";

void test("local extension trash supports undo without losing the original path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-trash-"));
  const source = join(root, "extension.ts");
  try {
    await writeFile(source, "export default {};\n", "utf8");
    const record = await moveToExtensionTrash(source, join(root, "trash"));
    await undoExtensionTrash(record);
    assert.equal(await readFile(source, "utf8"), "export default {};\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
