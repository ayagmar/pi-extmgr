import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildWorkspaceNavigation,
  matchWorkspaceNavigation,
} from "../src/ui/workspace/navigation.js";

initTheme();

const TAB = "\t";
const SHIFT_TAB = "\u001b[Z";

void test("Tab and Shift+Tab cycle every workspace and wrap", () => {
  assert.equal(matchWorkspaceNavigation(TAB, "installed"), "discover");
  assert.equal(matchWorkspaceNavigation(TAB, "discover"), "profiles");
  assert.equal(matchWorkspaceNavigation(TAB, "profiles"), "health");
  assert.equal(matchWorkspaceNavigation(TAB, "health"), "installed");

  assert.equal(matchWorkspaceNavigation(SHIFT_TAB, "installed"), "health");
  assert.equal(matchWorkspaceNavigation(SHIFT_TAB, "health"), "profiles");
  assert.equal(matchWorkspaceNavigation(SHIFT_TAB, "profiles"), "discover");
  assert.equal(matchWorkspaceNavigation(SHIFT_TAB, "discover"), "installed");
});

void test("workspace navigation accepts legacy and Kitty tab encodings", () => {
  assert.equal(matchWorkspaceNavigation("\u001b[9u", "installed"), "discover");
  assert.equal(matchWorkspaceNavigation("\u001b[9;2u", "installed"), "health");
  assert.equal(matchWorkspaceNavigation("\u001b[9;1:2u", "discover"), "profiles");
  assert.equal(matchWorkspaceNavigation("\u001b[9;2:2u", "discover"), "installed");
});

void test("workspace navigation ignores releases and unrelated input", () => {
  assert.equal(matchWorkspaceNavigation("\u001b[9;1:3u", "installed"), undefined);
  assert.equal(matchWorkspaceNavigation("\u001b[9;2:3u", "installed"), undefined);
  assert.equal(matchWorkspaceNavigation("x", "installed"), undefined);
  assert.equal(matchWorkspaceNavigation("[", "installed"), undefined);
  assert.equal(matchWorkspaceNavigation("\u001b[P", "installed"), undefined);
  assert.equal(matchWorkspaceNavigation("\u001b", "installed"), undefined);
});

void test("workspace navigation header highlights the active screen and explains cycling", () => {
  const theme = {
    fg: (color: string, text: string) => (color === "accent" ? `<${text}>` : text),
  };
  const header = buildWorkspaceNavigation(theme, "profiles");
  assert.ok(header.includes("<[Profiles]>"));
  assert.ok(header.includes("Installed"));
  assert.ok(header.includes("Discover"));
  assert.ok(header.includes("Health"));
  assert.ok(header.includes("Shift+Tab ‹"));
  assert.ok(header.includes("› Tab"));

  const plain = buildWorkspaceNavigation({ fg: (_c, text) => text }, "installed");
  assert.ok(
    visibleWidth(plain) < 80,
    `expected navigation to fit 80 columns, got ${visibleWidth(plain)}`
  );
});
