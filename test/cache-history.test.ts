import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { clearMetadataCacheCommand } from "../src/commands/cache.js";
import { getSearchCache, setSearchCache } from "../src/packages/discovery.js";
import {
  formatChangeEntry,
  logAutoUpdateConfig,
  logExtensionDelete,
  queryGlobalHistory,
  querySessionChanges,
} from "../src/utils/history.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("clearMetadataCacheCommand clears runtime search cache and records history", async () => {
  setSearchCache({
    query: "demo",
    results: [{ name: "demo", description: "demo package" }],
    timestamp: Date.now(),
  });

  const { pi, ctx, entries, notifications } = createMockHarness({ hasUI: true });

  await clearMetadataCacheCommand(ctx, pi);

  assert.equal(getSearchCache(), null);
  assert.ok(notifications.some((entry) => entry.message.includes("in-memory extmgr caches")));

  const historyEntry = entries.find((entry) => entry.customType === "extmgr-change")?.data as
    | { action?: string; success?: boolean }
    | undefined;
  assert.equal(historyEntry?.action, "cache_clear");
  assert.equal(historyEntry?.success, true);
});

void test("queryGlobalHistory keeps the latest matching entries without loading more than needed", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-extmgr-history-"));

  try {
    await mkdir(join(sessionDir, "nested"), { recursive: true });
    await writeFile(
      join(sessionDir, "first.jsonl"),
      [
        JSON.stringify({ type: "custom", customType: "other", data: {} }),
        "not json",
        JSON.stringify({
          type: "custom",
          customType: "extmgr-change",
          data: { action: "cache_clear", timestamp: 10, success: true },
        }),
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(sessionDir, "nested", "second.jsonl"),
      [
        JSON.stringify({
          type: "custom",
          customType: "extmgr-change",
          data: { action: "package_install", timestamp: 30, success: true, packageName: "demo" },
        }),
        JSON.stringify({
          type: "custom",
          customType: "extmgr-change",
          data: { action: "package_update", timestamp: 20, success: true, packageName: "demo" },
        }),
      ].join("\n"),
      "utf8"
    );

    const changes = await queryGlobalHistory({ limit: 2 }, sessionDir);

    assert.deepEqual(
      changes.map((entry) => entry.change.timestamp),
      [20, 30]
    );
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

void test("history records local extension deletion and auto-update config changes", () => {
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

  logExtensionDelete(pi, "global:/tmp/demo.ts", true);
  logAutoUpdateConfig(pi, "set to weekly", true);

  const changes = querySessionChanges(ctx, { limit: 10 });
  assert.deepEqual(
    changes.map((change) => change.action),
    ["extension_delete", "auto_update_config"]
  );

  const [firstChange, secondChange] = changes;
  assert.ok(firstChange);
  assert.ok(secondChange);
  assert.match(formatChangeEntry(firstChange), /Deleted/);
  assert.match(formatChangeEntry(secondChange), /Auto-update set to weekly/);
});
