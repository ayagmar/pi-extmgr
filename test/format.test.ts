import assert from "node:assert/strict";
import test from "node:test";
import { truncate } from "../src/utils/format.js";

void test("truncate never exceeds maxLength when maxLength is 3 or less", () => {
  assert.equal(truncate("abcdef", 3), "abc");
  assert.equal(truncate("abcdef", 2), "ab");
  assert.equal(truncate("abcdef", 1), "a");
  assert.equal(truncate("abcdef", 0), "");
});

void test("truncate keeps ellipsis behavior for longer limits", () => {
  assert.equal(truncate("abcdef", 4), "a...");
  assert.equal(truncate("abcdef", 5), "ab...");
});
