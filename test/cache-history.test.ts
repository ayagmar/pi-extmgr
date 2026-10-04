import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { clearMetadataCacheCommand } from "../src/commands/cache.js";
import { handleHistorySubcommand, resolveCustomSessionDir } from "../src/commands/history.js";
import { getSearchCache, setSearchCache } from "../src/packages/discovery.js";
import {
  formatChangeEntry,
  logAutoUpdateConfig,
  logExtensionDelete,
  queryGlobalHistory,
  queryPackageTimeline,
  querySessionChanges,
} from "../src/utils/history.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("clearMetadataCacheCommand clears runtime search cache and records history", async () => {
  setSearchCache({
    query: "demo",
    results: [{ name: "demo", description: "demo package" }],
    total: 1,
    offset: 0,
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
    const first = SessionManager.create(join(sessionDir, "first-project"), sessionDir);
    first.appendMessage({ role: "user", content: "history", timestamp: Date.now() });
    first.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    first.appendCustomEntry("extmgr-change", {
      action: "cache_clear",
      timestamp: 10,
      success: true,
    });
    const second = SessionManager.create(join(sessionDir, "second-project"), sessionDir);
    second.appendMessage({ role: "user", content: "history", timestamp: Date.now() });
    second.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    second.appendCustomEntry("extmgr-change", {
      action: "package_install",
      timestamp: 30,
      success: true,
      packageName: "demo",
    });
    second.appendCustomEntry("extmgr-change", {
      action: "package_update",
      timestamp: 20,
      success: true,
      packageName: "demo",
    });
    await writeFile(join(sessionDir, "malformed.jsonl"), "not json\n", "utf8");

    const changes = await queryGlobalHistory({ limit: 2 }, sessionDir);

    assert.deepEqual(
      changes.map((entry) => entry.change.timestamp),
      [20, 30]
    );
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

void test("queryPackageTimeline returns package activity in chronological order", () => {
  const entries: { type: "custom"; customType: string; data: unknown }[] = [
    {
      type: "custom",
      customType: "extmgr-change",
      data: { action: "package_update", timestamp: 30, success: true, packageName: "demo" },
    },
    {
      type: "custom",
      customType: "extmgr-change",
      data: { action: "package_install", timestamp: 10, success: true, packageName: "demo" },
    },
  ];
  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionCommandContext;

  assert.deepEqual(
    queryPackageTimeline(ctx, "demo").map((change) => change.timestamp),
    [10, 30]
  );
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
  assert.match(formatChangeEntry(secondChange), /Scheduled update checks set to weekly/);
});

async function withAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-extmgr-history-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

function withSessionDir(ctx: ExtensionCommandContext, sessionDir: string): void {
  (ctx.sessionManager as unknown as { getSessionDir: () => string }).getSessionDir = () =>
    sessionDir;
}

void test("history --global reads sessions from pi's custom session dir", async () => {
  await withAgentDir(async () => {
    const customDir = await mkdtemp(join(tmpdir(), "pi-extmgr-custom-sessions-"));
    try {
      const session = SessionManager.create(join(customDir, "project"), customDir);
      session.appendMessage({ role: "user", content: "history", timestamp: Date.now() });
      session.appendCustomEntry("extmgr-change", {
        action: "cache_clear",
        timestamp: 42,
        success: true,
      });
      session.appendMessage({
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const { pi, ctx, notifications } = createMockHarness({ hasUI: true, mode: "rpc" });
      withSessionDir(ctx, customDir);
      assert.equal(resolveCustomSessionDir(ctx), customDir);

      await handleHistorySubcommand(ctx, pi, ["--global"], true);

      assert.ok(
        notifications.some((note) => note.message.includes("Extension Change History (global")),
        JSON.stringify(notifications)
      );
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });
});

void test("history --global scans every project when pi uses its default session dir", async () => {
  await withAgentDir(async (agentDir) => {
    const { ctx } = createMockHarness();
    withSessionDir(ctx, join(agentDir, "sessions", "--repo--"));
    assert.equal(resolveCustomSessionDir(ctx), undefined);
  });
});
