import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runResolvedCommand } from "../src/commands/registry.js";
import { reviewAndApplyProfileWithOutcome } from "../src/profiles/execute.js";
import { configurePackageExtensions } from "../src/ui/package-config.js";
import { showRemote } from "../src/ui/remote.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("/extensions does not attempt custom panels in explicit RPC mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-"));
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:demo-pkg@1.0.0", name: "demo-pkg", version: "1.0.0", scope: "global" },
    ],
  });

  try {
    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      mode: "rpc",
      execImpl: (command, args) => {
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
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions falls back when custom() degrades to undefined", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-custom-"));
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:demo-pkg@1.0.0", name: "demo-pkg", version: "1.0.0", scope: "global" },
    ],
  });

  try {
    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      execImpl: (command, args) => {
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

    // Degraded custom UI: the manager and any report panels resolve
    // undefined, so all content must still reach plain notifications.
    assert.ok(customCallCount() >= 1, "expected the manager to attempt custom UI");
    assert.ok(
      notifications.some((entry) => entry.message.includes("requires the full interactive TUI"))
    );
    assert.ok(notifications.some((entry) => entry.message.includes("demo-pkg")));
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions installed does not attempt a custom report in explicit RPC mode", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:demo-pkg@1.0.0", name: "demo-pkg", version: "1.0.0", scope: "global" },
      { source: "npm:demo-pkg@1.0.0", name: "demo-pkg", version: "1.0.0", scope: "project" },
    ],
  });

  try {
    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      hasUI: true,
      mode: "rpc",
      execImpl: (command, args) => {
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

    const installedNotification = notifications.find((entry) =>
      entry.message.includes("Installed packages:")
    );

    assert.ok(installedNotification);
    assert.ok(installedNotification.message.includes("demo-pkg @1.0.0 (global)"));
    assert.ok(installedNotification.message.includes("demo-pkg @1.0.0 (project)"));
  } finally {
    restoreCatalog();
  }
});

void test("remote browsing warns instead of calling custom UI in RPC mode", async () => {
  const { pi, ctx, notifications, customCallCount } = createMockHarness({
    hasUI: true,
    mode: "rpc",
  });

  await showRemote("", ctx, pi);

  assert.equal(customCallCount(), 0);
  assert.ok(
    notifications.some((entry) =>
      entry.message.includes("Remote package browsing requires the full interactive TUI")
    )
  );
});

void test("remote install prompt still works in RPC mode", async () => {
  const installs: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx, customCallCount, inputPrompts } = createMockHarness({
      hasUI: true,
      mode: "rpc",
      inputResult: "npm:demo-pkg",
      selectResult: "Global (~/.pi/agent/settings.json)",
      confirmImpl: (title) => title === "Install Package",
    });

    await showRemote("install", ctx, pi);

    assert.equal(customCallCount(), 0);
    assert.ok(inputPrompts.includes("Install package"));
    assert.deepEqual(installs, [{ source: "npm:demo-pkg", scope: "global" }]);
  } finally {
    restoreCatalog();
  }
});

void test("package config handles custom() degrading to undefined", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-config-custom-"));
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
    assert.equal(customCallCount(), 1);
    assert.ok(
      notifications.some((entry) =>
        entry.message.includes("Package extension configuration requires the full interactive TUI")
      )
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("RPC profile apply uses confirmation and never attempts custom UI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-rpc-profile-"));
  let installs = 0;
  let applyConfirmations = 0;
  const restoreCatalog = mockPackageCatalog({
    packages: [],
    installImpl: () => {
      installs += 1;
    },
  });

  try {
    const { pi, ctx, confirmPrompts, customCallCount } = createMockHarness({
      cwd,
      hasUI: true,
      mode: "rpc",
      confirmImpl: (title) => {
        if (title !== "Apply profile") return false;
        applyConfirmations += 1;
        return applyConfirmations === 2;
      },
    });
    const current = { schemaVersion: 1 as const, name: "current", packages: [] };
    const desired = {
      schemaVersion: 1 as const,
      name: "rpc-profile",
      packages: [{ source: "npm:demo", scope: "global" as const, version: "1.0.0" }],
    };

    const cancelled = await reviewAndApplyProfileWithOutcome(current, desired, ctx, pi);

    assert.equal(cancelled.applied, false);
    assert.equal(installs, 0, "RPC must not apply before confirmation");
    assert.equal(customCallCount(), 0);

    const applied = await reviewAndApplyProfileWithOutcome(current, desired, ctx, pi);

    assert.equal(applied.applied, true);
    assert.equal(installs, 1, "RPC should apply after confirmation");
    assert.equal(customCallCount(), 0);
    assert.deepEqual(
      confirmPrompts.filter((title) => title === "Apply profile"),
      ["Apply profile", "Apply profile"]
    );
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("package config does not attempt custom UI in RPC mode", async () => {
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
      mode: "rpc",
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
