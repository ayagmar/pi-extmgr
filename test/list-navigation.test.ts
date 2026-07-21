import assert from "node:assert/strict";
import test from "node:test";
import { getCenteredVisibleRange, moveListSelection } from "../src/ui/list-navigation.js";

void test("list navigation wraps arrow movement and clamps page movement", () => {
  assert.equal(moveListSelection(0, -1, 4, { wrap: true }), 3);
  assert.equal(moveListSelection(3, 1, 4, { wrap: true }), 0);
  assert.equal(moveListSelection(0, -3, 4), 0);
  assert.equal(moveListSelection(1, 10, 4), 3);
  assert.equal(moveListSelection(8, 1, 0, { wrap: true }), 0);
});

void test("centered visible ranges follow selection without exceeding list bounds", () => {
  assert.deepEqual(getCenteredVisibleRange(0, 10, 4), { startIndex: 0, endIndex: 4 });
  assert.deepEqual(getCenteredVisibleRange(5, 10, 4), { startIndex: 3, endIndex: 7 });
  assert.deepEqual(getCenteredVisibleRange(9, 10, 4), { startIndex: 6, endIndex: 10 });
  assert.deepEqual(getCenteredVisibleRange(0, 0, 4), { startIndex: 0, endIndex: 0 });
});
