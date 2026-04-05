import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeRelativePath,
  resolveRelativePathSelection,
} from "../src/utils/relative-path-selection.js";

void test("isSafeRelativePath rejects Windows absolute and UNC paths", () => {
  assert.equal(isSafeRelativePath("C:/repo/extensions/index.ts"), false);
  assert.equal(isSafeRelativePath("C:\\repo\\extensions\\index.ts"), false);
  assert.equal(isSafeRelativePath("\\\\server\\share\\index.ts"), false);
  assert.equal(isSafeRelativePath("extensions/index.ts"), true);
});

void test("resolveRelativePathSelection ignores Windows absolute tokens", () => {
  const selected = resolveRelativePathSelection(
    ["extensions/index.ts"],
    ["C:/repo/extensions/index.ts", "\\\\server\\share\\index.ts"],
    () => true
  );

  assert.deepEqual(selected, []);
});
