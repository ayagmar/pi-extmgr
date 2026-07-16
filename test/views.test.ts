import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeViewsFile, readSavedViews, writeSavedViews } from "../src/utils/views.js";

void test("saved views normalize versioned view, favorite, and recent state", () => {
  const result = normalizeViewsFile({
    version: 99,
    views: [
      { name: " work ", filter: "packages", searchQuery: "demo", createdAt: 1, updatedAt: 2 },
    ],
    favorites: [" demo ", 1],
    recent: Array.from({ length: 30 }, (_, index) => `pkg-${index}`),
    lastView: {
      name: "last-used",
      filter: "favorites",
      searchQuery: "demo",
      selectedItemId: "pkg:demo",
      createdAt: 1,
      updatedAt: 2,
    },
  });
  assert.equal(result.version, 1);
  assert.equal(result.views[0]?.name, "work");
  assert.deepEqual(result.favorites, ["demo"]);
  assert.equal(result.recent.length, 20);
  assert.equal(result.lastView?.selectedItemId, "pkg:demo");
});

void test("saved views use an atomic replacement write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-views-"));
  const path = join(dir, "views.json");
  try {
    await Promise.all([
      writeSavedViews(path, { version: 1, views: [], favorites: ["first"], recent: [] }),
      writeSavedViews(path, { version: 1, views: [], favorites: ["demo"], recent: [] }),
    ]);
    assert.deepEqual((await readSavedViews(path)).favorites, ["demo"]);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
