import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResolvedCommand } from "../src/commands/registry.js";
import { showRemote } from "../src/ui/remote.js";
import { configurePackageExtensions } from "../src/ui/package-config.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("/extensions falls back cleanly when custom TUI is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-"));

  try {
    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      hasCustomUI: false,
      execImpl: (command, args) => {
        if (command === "pi" && args[0] === "list") {
          return {
            code: 0,
            stdout: "Global:\n  npm:demo-pkg@1.0.0\n",
            stderr: "",
            killed: false,
          };
        }

        if (command === "npm" && args[0] === "view" && args[2] === "description") {
          return { code: 0, stdout: '"demo package"', stderr: "", killed: false };
        }

        if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
          return { code: 0, stdout: "2048", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    await runResolvedCommand({ id: "local", args: [] }, ctx, pi);

    assert.equal(customCallCount(), 0);
    assert.ok(
      notifications.some((entry) => entry.message.includes("requires the full interactive TUI"))
    );
    assert.ok(notifications.some((entry) => entry.message.includes("demo-pkg")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions installed lists packages without custom TUI", async () => {
  const { pi, ctx, notifications, customCallCount } = createMockHarness({
    hasUI: true,
    hasCustomUI: false,
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Project:\n  npm:demo-pkg@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }

      if (command === "npm" && args[0] === "view" && args[2] === "description") {
        return { code: 0, stdout: '"demo package"', stderr: "", killed: false };
      }

      if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
        return { code: 0, stdout: "1024", stderr: "", killed: false };
      }

      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  });

  await runResolvedCommand({ id: "installed", args: [] }, ctx, pi);

  assert.equal(customCallCount(), 0);
  assert.ok(notifications.some((entry) => entry.message.includes("demo-pkg")));
});

void test("remote browsing warns instead of calling custom UI in RPC mode", async () => {
  const { pi, ctx, notifications, customCallCount } = createMockHarness({
    hasUI: true,
    hasCustomUI: false,
  });

  await showRemote("", ctx, pi);

  assert.equal(customCallCount(), 0);
  assert.ok(
    notifications.some((entry) =>
      entry.message.includes("Remote package browsing requires the full interactive TUI")
    )
  );
});

void test("remote install prompt still works without custom TUI", async () => {
  const { pi, ctx, calls, customCallCount, inputPrompts } = createMockHarness({
    hasUI: true,
    hasCustomUI: false,
    inputResult: "npm:demo-pkg",
    selectResult: "Global (~/.pi/agent/settings.json)",
    confirmImpl: (title) => title === "Install Package",
  });

  await showRemote("install", ctx, pi);

  assert.equal(customCallCount(), 0);
  assert.ok(inputPrompts.includes("Install package"));

  const installCalls = calls.filter((call) => call.command === "pi" && call.args[0] === "install");
  assert.equal(installCalls.length, 1);
  assert.deepEqual(installCalls[0]?.args, ["install", "npm:demo-pkg"]);
});

void test("package config warns and exits when custom TUI is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo", pi: { extensions: ["./index.ts"] } }, null, 2),
      "utf8"
    );
    await writeFile(join(pkgRoot, "index.ts"), "// demo\n", "utf8");

    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      hasCustomUI: false,
    });

    const result = await configurePackageExtensions(
      {
        source: "./vendor/demo",
        name: "demo",
        scope: "project",
        resolvedPath: pkgRoot,
      },
      ctx,
      pi
    );

    assert.deepEqual(result, { changed: 0, reloaded: false });
    assert.equal(customCallCount(), 0);
    assert.ok(
      notifications.some((entry) =>
        entry.message.includes("Package extension configuration requires the full interactive TUI")
      )
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
