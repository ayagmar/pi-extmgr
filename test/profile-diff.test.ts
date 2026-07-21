import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeProfile } from "../src/profiles/schema.js";
import { describeProfilePackageChanges, renderProfileDiffLines } from "../src/ui/profiles.js";

initTheme();

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

void test("profile package change descriptions cover scope, version, ref, filters, and manifest fingerprint", () => {
  const changes = describeProfilePackageChanges(
    {
      source: "npm:demo",
      scope: "global",
      version: "1.0.0",
      ref: "main",
      filters: ["extensions/a.ts"],
      checksum: "sha256:aaaaaaaaaaaaaaaa",
    },
    {
      source: "npm:demo",
      scope: "project",
      version: "2.0.0",
      ref: "release",
      filters: ["extensions/b.ts"],
      checksum: "sha256:bbbbbbbbbbbbbbbb",
    }
  );

  assert.ok(changes.some((change) => change.includes("scope global → project")));
  assert.ok(changes.some((change) => change.includes("version 1.0.0 → 2.0.0")));
  assert.ok(changes.some((change) => change.includes("ref main → release")));
  assert.ok(changes.some((change) => change.includes("filters extensions/a.ts → extensions/b.ts")));
  assert.ok(changes.some((change) => change.includes("manifest fingerprint sha256:aaa")));
  assert.equal(changes.length, 5);
});

void test("profile diff rendering shows adds, removes, and per-field changes in wide mode", () => {
  const current = normalizeProfile({
    name: "current",
    packages: [
      { source: "npm:removed", scope: "global" },
      { source: "npm:changed", scope: "global", version: "1.0.0" },
    ],
  });
  const desired = normalizeProfile({
    name: "target",
    packages: [
      { source: "npm:added", scope: "project" },
      { source: "npm:changed", scope: "global", version: "2.0.0" },
    ],
  });

  const lines = renderProfileDiffLines(current, desired, [], 120, plainTheme, {
    canApply: true,
    cancelHint: "Esc back",
  });

  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  assert.ok(lines.some((line) => line.includes("1 added · 1 removed · 1 changed")));
  assert.ok(lines.some((line) => line.includes("Current")));
  assert.ok(lines.some((line) => line.includes("Target · target")));
  assert.ok(lines.some((line) => line.includes("+ npm:added")));
  assert.ok(lines.some((line) => line.includes("- npm:removed")));
  assert.ok(lines.some((line) => line.includes("~ npm:changed")));
  assert.ok(lines.some((line) => line.includes("version 1.0.0 → 2.0.0")));
  assert.ok(lines.some((line) => line.includes("a apply")));
});

void test("profile diff rendering stays within narrow widths and hides apply when blocked", () => {
  const current = normalizeProfile({ name: "current", packages: [] });
  const desired = normalizeProfile({
    name: "target",
    packages: [
      {
        source: "npm:very-long-package-name-that-would-overflow",
        scope: "project",
        version: "10.20.30",
      },
    ],
  });
  const violations = [{ message: "scope project is not allowed" }];

  const lines = renderProfileDiffLines(current, desired, violations, 40, plainTheme, {
    canApply: false,
    cancelHint: "Esc back",
  });

  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
  assert.ok(lines.some((line) => line.includes("Policy blocks application")));
  assert.ok(lines.some((line) => line.includes("scope project is not allowed")));
  assert.ok(!lines.some((line) => line.includes("a apply")));
  assert.ok(lines.some((line) => line.includes("npm:very-long-package-name")));
});

void test("profile diff rendering reports when nothing changes", () => {
  const profile = normalizeProfile({
    name: "same",
    packages: [{ source: "npm:demo", scope: "global" }],
  });
  const lines = renderProfileDiffLines(profile, profile, [], 120, plainTheme, {
    canApply: false,
    cancelHint: "Esc back",
  });
  assert.ok(lines.some((line) => line.includes("No package changes")));
  assert.ok(lines.some((line) => line.includes("0 added · 0 removed · 0 changed")));
});
