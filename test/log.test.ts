import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionsManager from "../src/index.js";
import { stopAutoUpdateTimer } from "../src/utils/auto-update.js";
import { logWarning, setConsoleDiagnosticsEnabled } from "../src/utils/log.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

function captureWarnings(run: () => void): unknown[][] {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

void test("logWarning stays silent while the TUI owns the terminal", () => {
  try {
    setConsoleDiagnosticsEnabled(false);
    assert.deepEqual(
      captureWarnings(() => logWarning("hidden")),
      []
    );
    setConsoleDiagnosticsEnabled(true);
    assert.deepEqual(
      captureWarnings(() => logWarning("shown", "detail")),
      [["[extmgr] shown", "detail"]]
    );
  } finally {
    setConsoleDiagnosticsEnabled(true);
  }
});

void test("session_start turns console diagnostics off in TUI mode and back on elsewhere", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const pi = {
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;
  const restoreCatalog = mockPackageCatalog();

  try {
    extensionsManager(pi);
    const tui = createMockHarness({ hasUI: true, mode: "tui" }).ctx;
    await handlers.get("session_start")?.({ reason: "startup" }, tui);
    assert.deepEqual(
      captureWarnings(() => logWarning("hidden")),
      []
    );

    const print = createMockHarness({ hasUI: false, mode: "print" }).ctx;
    await handlers.get("session_start")?.({ reason: "startup" }, print);
    assert.equal(captureWarnings(() => logWarning("shown")).length, 1);
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, undefined);
    restoreCatalog();
    stopAutoUpdateTimer();
    setConsoleDiagnosticsEnabled(true);
  }
});
