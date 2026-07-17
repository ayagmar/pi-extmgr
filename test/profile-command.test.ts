import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleProfileSubcommand } from "../src/commands/profile.js";
import { buildHelpLines } from "../src/ui/help.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("profile export writes exact installed source, scope, and version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-profile-command-"));
  const restore = mockPackageCatalog({
    packages: [{ source: "npm:demo@1.2.3", name: "demo", version: "1.2.3", scope: "project" }],
  });
  try {
    const { ctx } = createMockHarness({ cwd });
    await handleProfileSubcommand(["export", "profile.json"], ctx);
    const profile = JSON.parse(await readFile(join(cwd, "profile.json"), "utf8")) as {
      packages: Array<{ source: string; scope: string; version: string }>;
    };
    assert.deepEqual(profile.packages[0], {
      source: "npm:demo@1.2.3",
      scope: "project",
      version: "1.2.3",
    });
  } finally {
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("manager help stays compact and width-safe", () => {
  const lines = buildHelpLines();
  assert.ok(lines.includes("Extensions Manager Help"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 88));
  assert.ok(lines.some((line) => line.includes("Bulk actions")));
  assert.ok(lines.some((line) => line.includes("Reload required")));
});
