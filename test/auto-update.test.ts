import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extensionsManager from "../src/index.js";
import {
  checkForUpdates,
  isAutoUpdateRunning,
  stopAutoUpdateTimer,
} from "../src/utils/auto-update.js";
import { parseDuration } from "../src/utils/settings.js";
import { createMockHarness, type ExecResult } from "./helpers/mocks.js";

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
  const { pi, ctx } = createMockHarness({
    execImpl: (command: string, args: string[]): ExecResult => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  npm:demo-pkg@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }

      if (command === "npm" && args[0] === "view" && args[2] === "description") {
        return { code: 0, stdout: '"demo"', stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
        return { code: 0, stdout: "1234", stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "version") {
        return { code: 0, stdout: '"1.1.0"', stderr: "", killed: false };
      }

      return { code: 1, stdout: "", stderr: "unknown call", killed: false };
    },
  });

  const updates = await checkForUpdates(pi, ctx);
  assert.deepEqual(updates, ["demo-pkg"]);
});

void test("checkForUpdates handles scoped npm packages", async () => {
  const npmViewCalls: string[] = [];

  const { pi, ctx } = createMockHarness({
    execImpl: (command: string, args: string[]): ExecResult => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  npm:@scope/demo-pkg@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }

      if (command === "npm" && args[0] === "view") {
        npmViewCalls.push(args[1] ?? "");
      }

      if (command === "npm" && args[0] === "view" && args[2] === "description") {
        return { code: 0, stdout: '"scoped demo"', stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
        return { code: 0, stdout: "4321", stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "version") {
        return { code: 0, stdout: '"1.1.0"', stderr: "", killed: false };
      }

      return { code: 1, stdout: "", stderr: "unknown call", killed: false };
    },
  });

  const updates = await checkForUpdates(pi, ctx);
  assert.deepEqual(updates, ["@scope/demo-pkg"]);
  assert.ok(npmViewCalls.includes("@scope/demo-pkg"));
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
    exec: (command: string, args: string[]) =>
      Promise.resolve(
        command === "pi" && args[0] === "list"
          ? { code: 0, stdout: "No packages installed", stderr: "", killed: false }
          : { code: 0, stdout: "", stderr: "", killed: false }
      ),
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

  try {
    extensionsManager(pi as unknown as ExtensionAPI);

    await handlers["session_start"]?.({}, enabledCtx);
    assert.equal(isAutoUpdateRunning(), true);

    await handlers["session_switch"]?.({}, disabledCtx);
    assert.equal(isAutoUpdateRunning(), false);
  } finally {
    stopAutoUpdateTimer();
  }
});
