import assert from "node:assert/strict";
import test from "node:test";
import { getRemotePackageBadges } from "../src/packages/badges.js";

void test("remote package badges distinguish installed and update states", () => {
  const badges = getRemotePackageBadges({ name: "demo" }, new Set(["demo"]), new Set(["demo"]));
  assert.deepEqual(badges, { installed: true, updateAvailable: true, compatibility: "unknown" });
});
