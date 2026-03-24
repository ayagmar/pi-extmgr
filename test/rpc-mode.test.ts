import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResolvedCommand } from "../src/commands/registry.js";
import { showRemote } from "../src/ui/remote.js";
import { configurePackageExtensions } from "../src/ui/package-config.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("/extensions falls back cleanly when custom TUI is unavailable", async () => {
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
      hasCustomUI: false,
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

    assert.equal(customCallCount(), 1);
    assert.ok(
      notifications.some((entry) => entry.message.includes("requires the full interactive TUI"))
    );
    assert.ok(notifications.some((entry) => entry.message.includes("demo-pkg")));
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions installed lists packages without custom TUI", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:demo-pkg@1.0.0", name: "demo-pkg", version: "1.0.0", scope: "project" },
    ],
  });

  try {
    const { pi, ctx, notifications, customCallCount } = createMockHarness({
      hasUI: true,
      hasCustomUI: false,
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
    assert.ok(notifications.some((entry) => entry.message.includes("demo-pkg")));
  } finally {
    restoreCatalog();
  }
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
  const installs: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx, customCallCount, inputPrompts } = createMockHarness({
      hasUI: true,
      hasCustomUI: false,
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
