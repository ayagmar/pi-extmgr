import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extensionsManager from "../src/index.js";
import { setPackageCatalogFactory } from "../src/packages/catalog.js";
import {
  checkForUpdates,
  enableAutoUpdate,
  getKnownUpdates,
  isAutoUpdateRunning,
  startAutoUpdateTimer,
  stopAutoUpdateTimer,
} from "../src/utils/auto-update.js";
import { parseDuration } from "../src/utils/settings.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("parseDuration supports flexible durations", () => {
  assert.deepEqual(parseDuration("1h"), { ms: 60 * 60 * 1000, display: "1 hour" });
  assert.deepEqual(parseDuration("3d"), { ms: 3 * 24 * 60 * 60 * 1000, display: "3 days" });
  assert.deepEqual(parseDuration("2w"), {
    ms: 2 * 7 * 24 * 60 * 60 * 1000,
    display: "2 weeks",
  });
  assert.deepEqual(parseDuration("1m"), {
    ms: 30 * 24 * 60 * 60 * 1000,
    display: "1 month",
  });
  assert.deepEqual(parseDuration("never"), { ms: 0, display: "off" });
  assert.equal(parseDuration("nope"), undefined);
});

void test("checkForUpdates detects npm package update availability", async () => {
  const restoreCatalog = mockPackageCatalog({
    updates: [
      {
        source: "npm:demo-pkg@1.0.0",
        displayName: "demo-pkg",
        type: "npm",
        scope: "global",
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness();
    const updates = await checkForUpdates(pi, ctx);
    assert.deepEqual(updates, ["demo-pkg"]);
  } finally {
    restoreCatalog();
  }
});

void test("checkForUpdates handles scoped npm packages", async () => {
  const restoreCatalog = mockPackageCatalog({
    updates: [
      {
        source: "npm:@scope/demo-pkg@1.0.0",
        displayName: "@scope/demo-pkg",
        type: "npm",
        scope: "global",
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness();
    const updates = await checkForUpdates(pi, ctx);
    assert.deepEqual(updates, ["@scope/demo-pkg"]);
  } finally {
    restoreCatalog();
  }
});

void test("session switch to disabled auto-update stops existing timer", async () => {
  interface SessionCtx {
    hasUI: true;
    cwd: string;
    ui: {
      notify: (message: string, level?: string) => void;
      setStatus: (key: string, value: string | undefined) => void;
      theme: { fg: (name: string, text: string) => string };
    };
    sessionManager: {
      getEntries: () => { type: "custom"; customType: string; data: unknown }[];
    };
  }

  const handlers: Record<string, ((event: unknown, ctx: SessionCtx) => Promise<void>) | undefined> =
    {};

  const pi = {
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: SessionCtx) => Promise<void>) => {
      handlers[event] = handler;
    },
    appendEntry: () => undefined,
  };

  const ui: SessionCtx["ui"] = {
    notify: () => undefined,
    setStatus: () => undefined,
    theme: { fg: (_name: string, text: string) => text },
  };

  const enabledCtx: SessionCtx = {
    hasUI: true,
    cwd: "/tmp",
    ui,
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "extmgr-auto-update",
          data: { enabled: true, intervalMs: 60 * 60 * 1000, displayText: "1 hour" },
        },
      ],
    },
  };

  const disabledCtx: SessionCtx = {
    hasUI: true,
    cwd: "/tmp",
    ui,
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "extmgr-auto-update",
          data: { enabled: false, intervalMs: 0, displayText: "off" },
        },
      ],
    },
  };

  const restoreCatalog = mockPackageCatalog();

  try {
    extensionsManager(pi as unknown as ExtensionAPI);

    await handlers["session_start"]?.({}, enabledCtx);
    assert.equal(isAutoUpdateRunning(), true);

    await handlers["session_switch"]?.({}, disabledCtx);
    assert.equal(isAutoUpdateRunning(), false);
  } finally {
    restoreCatalog();
    stopAutoUpdateTimer();
  }
});

void test("startAutoUpdateTimer waits until persisted nextCheck when not yet due", async () => {
  const entries = [
    {
      type: "custom" as const,
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 1000,
        displayText: "1 second",
        nextCheck: Date.now() + 120,
      },
    },
  ];

  let updateChecks = 0;
  setPackageCatalogFactory(() => ({
    listInstalledPackages() {
      return Promise.resolve([]);
    },
    checkForAvailableUpdates() {
      updateChecks += 1;
      return Promise.resolve([]);
    },
    install() {
      return Promise.resolve(undefined);
    },
    remove() {
      return Promise.resolve(undefined);
    },
    update() {
      return Promise.resolve(undefined);
    },
  }));

  const pi = {
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      theme: { fg: (_name: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ReturnType<typeof createMockHarness>["ctx"];

  try {
    startAutoUpdateTimer(pi, () => ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(updateChecks, 0);
  } finally {
    setPackageCatalogFactory();
    stopAutoUpdateTimer();
  }
});

void test("startAutoUpdateTimer checks immediately when persisted nextCheck is due", async () => {
  const entries = [
    {
      type: "custom" as const,
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 1000,
        displayText: "1 second",
        nextCheck: Date.now() - 1,
      },
    },
  ];

  let updateChecks = 0;
  setPackageCatalogFactory(() => ({
    listInstalledPackages() {
      return Promise.resolve([]);
    },
    checkForAvailableUpdates() {
      updateChecks += 1;
      return Promise.resolve([]);
    },
    install() {
      return Promise.resolve(undefined);
    },
    remove() {
      return Promise.resolve(undefined);
    },
    update() {
      return Promise.resolve(undefined);
    },
  }));

  const pi = {
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      theme: { fg: (_name: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ReturnType<typeof createMockHarness>["ctx"];

  try {
    startAutoUpdateTimer(pi, () => ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(updateChecks, 1);
  } finally {
    setPackageCatalogFactory();
    stopAutoUpdateTimer();
  }
});

void test("enableAutoUpdate records the next scheduled check without faking a completed run", () => {
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
  } as unknown as ReturnType<typeof createMockHarness>["ctx"];

  try {
    enableAutoUpdate(pi, ctx, 60 * 60 * 1000, "1 hour");

    const latestConfig = entries.filter((entry) => entry.customType === "extmgr-auto-update").at(-1)
      ?.data as { lastCheck?: number; nextCheck?: number; enabled?: boolean } | undefined;

    assert.equal(latestConfig?.enabled, true);
    assert.equal(latestConfig?.lastCheck, undefined);
    assert.ok(typeof latestConfig?.nextCheck === "number");
  } finally {
    stopAutoUpdateTimer();
  }
});

void test("getKnownUpdates ignores legacy name-only update markers", () => {
  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "extmgr-auto-update",
          data: {
            enabled: true,
            intervalMs: 60 * 60 * 1000,
            displayText: "1 hour",
            updatesAvailable: ["demo-pkg"],
          },
        },
      ],
    },
  } as unknown as ReturnType<typeof createMockHarness>["ctx"];

  assert.deepEqual(Array.from(getKnownUpdates(ctx)), []);
});

void test("getKnownUpdates normalizes stored update identities", () => {
  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "extmgr-auto-update",
          data: {
            enabled: true,
            intervalMs: 60 * 60 * 1000,
            displayText: "1 hour",
            updatesAvailable: [
              "npm:Demo-Pkg",
              "git:HTTPS://GitHub.com/User/Repo.git@main",
              "not-an-identity",
            ],
          },
        },
      ],
    },
  } as unknown as ReturnType<typeof createMockHarness>["ctx"];

  assert.deepEqual(Array.from(getKnownUpdates(ctx)).sort(), [
    "git:https://github.com/user/repo.git",
    "npm:demo-pkg",
  ]);
});
