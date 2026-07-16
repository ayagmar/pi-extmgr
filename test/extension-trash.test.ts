import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeLocalExtension } from "../src/extensions/discovery.js";
import { moveToExtensionTrash, undoExtensionTrash } from "../src/extensions/trash.js";

void test("removeLocalExtension moves files to trash and exposes undo", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-extmgr-trash-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const source = join(home, ".pi", "agent", "extensions", "demo.ts");
  try {
    await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
    await writeFile(source, "export default {};\n", "utf8");
    const result = await removeLocalExtension(
      { activePath: source, disabledPath: `${source}.disabled` },
      home
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      await undoExtensionTrash(result.trashRecord);
      assert.equal(await readFile(source, "utf8"), "export default {};\n");
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

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
