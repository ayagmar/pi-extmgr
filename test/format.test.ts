import assert from "node:assert/strict";
import test from "node:test";
import { formatEntry, truncate } from "../src/utils/format.js";

void test("local extension formatting uses the same textual metadata as Installed rows", () => {
  const line = formatEntry({
    id: "project:/workspace/.pi/extensions/demo.ts",
    scope: "project",
    state: "enabled",
    activePath: "/workspace/.pi/extensions/demo.ts",
    disabledPath: "/workspace/.pi/extensions/demo.ts.disabled",
    displayName: "demo.ts",
    summary: "Demo extension",
  });
  assert.equal(line, "demo.ts · local · project · enabled · Demo extension");
  assert.equal(line.includes("[G]"), false);
  assert.equal(line.includes("[P]"), false);
});

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
