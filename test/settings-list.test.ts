import test from "node:test";
import assert from "node:assert/strict";
import { getSettingsListSelectedIndex } from "../src/utils/settings-list.js";

void test("getSettingsListSelectedIndex only accepts integer indices", () => {
  assert.equal(getSettingsListSelectedIndex({ selectedIndex: 0 }), 0);
  assert.equal(getSettingsListSelectedIndex({ selectedIndex: 2 }), 2);
  assert.equal(getSettingsListSelectedIndex({ selectedIndex: 1.5 }), undefined);
  assert.equal(getSettingsListSelectedIndex({ selectedIndex: Number.NaN }), undefined);
  assert.equal(
    getSettingsListSelectedIndex({ selectedIndex: Number.POSITIVE_INFINITY }),
    undefined
  );
  assert.equal(getSettingsListSelectedIndex({ selectedIndex: "1" }), undefined);
  assert.equal(getSettingsListSelectedIndex(undefined), undefined);
});
