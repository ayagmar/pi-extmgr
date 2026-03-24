import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { installFromUrl, installPackage, installPackageLocally } from "../src/packages/install.js";
import { removePackage, updatePackage, updatePackages } from "../src/packages/management.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("installPackage installs the normalized npm source", async () => {
  const installs: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await installPackage("pi-extmgr", ctx, pi);

    assert.deepEqual(installs, [{ source: "npm:pi-extmgr", scope: "global" }]);
  } finally {
    restoreCatalog();
  }
});

void test("installPackage normalizes git@ sources to git: prefix", async () => {
  const installs: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await installPackage("git@github.com:user/repo.git", ctx, pi);

    assert.deepEqual(installs, [{ source: "git:git@github.com:user/repo.git", scope: "global" }]);
  } finally {
    restoreCatalog();
  }
});

void test("removePackage removes the selected package source", async () => {
  const removals: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [{ source: "npm:pi-extmgr", name: "pi-extmgr", scope: "global" }],
    removeImpl: (source, scope) => {
      removals.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await removePackage("npm:pi-extmgr", ctx, pi);

    assert.deepEqual(removals, [{ source: "npm:pi-extmgr", scope: "global" }]);
  } finally {
    restoreCatalog();
  }
});

void test("removePackage does not attempt removal when the package is not installed", async () => {
  const removals: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [],
    removeImpl: (source, scope) => {
      removals.push({ source, scope });
    },
  });

  try {
    const { pi, ctx, notifications } = createMockHarness({ hasUI: true });
    await removePackage("npm:missing", ctx, pi);

    assert.deepEqual(removals, []);
    assert.ok(
      notifications.some((entry) => entry.message.includes("npm:missing is not installed"))
    );
  } finally {
    restoreCatalog();
  }
});

void test("removePackage does not request reload when removal fails", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  const restoreCatalog = mockPackageCatalog({
    packages: [{ source: "npm:pi-extmgr", name: "pi-extmgr", scope: "global" }],
    removeImpl: () => {
      throw new Error("permission denied");
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await removePackage("npm:pi-extmgr", ctx, pi);
  } finally {
    restoreCatalog();
    console.log = originalLog;
  }

  assert.equal(
    output.some((line) => line.includes("Reload pi to apply changes. (Removal complete.)")),
    false
  );
});

void test("removePackage keeps successful removals when another scope fails", async () => {
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const removals: { source: string; scope: "global" | "project" }[] = [];
  const installed = [
    { source: "npm:demo@1.0.0", name: "demo", version: "1.0.0", scope: "global" as const },
    { source: "npm:demo@1.0.0", name: "demo", version: "1.0.0", scope: "project" as const },
  ];

  const restoreCatalog = mockPackageCatalog({
    packages: installed,
    removeImpl: (source, scope) => {
      removals.push({ source, scope });
      if (scope === "project") {
        throw new Error("permission denied");
      }
    },
  });

  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      select: (title: string) =>
        Promise.resolve(title === "Remove scope" ? "Both global + project" : undefined),
      confirm: (title: string) => Promise.resolve(title === "Remove Package"),
      setStatus: () => undefined,
      theme: { fg: (_name: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

  try {
    await removePackage("npm:demo@1.0.0", ctx, pi);
  } finally {
    restoreCatalog();
  }

  assert.deepEqual(removals, [
    { source: "npm:demo@1.0.0", scope: "global" },
    { source: "npm:demo@1.0.0", scope: "project" },
  ]);
});

void test("removePackage targets exact local source when names collide", async () => {
  const removals: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "/opt/extensions/alpha/index.ts", name: "index.ts", scope: "global" },
      { source: "/opt/extensions/beta/index.ts", name: "index.ts", scope: "global" },
    ],
    removeImpl: (source, scope) => {
      removals.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await removePackage("/opt/extensions/beta/index.ts", ctx, pi);
  } finally {
    restoreCatalog();
  }

  assert.deepEqual(removals, [{ source: "/opt/extensions/beta/index.ts", scope: "global" }]);
});

void test("removePackage keeps case-sensitive local paths distinct", async () => {
  const removals: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "/opt/extensions/Foo/index.ts", name: "index.ts", scope: "global" },
      { source: "/opt/extensions/foo/index.ts", name: "index.ts", scope: "global" },
    ],
    removeImpl: (source, scope) => {
      removals.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await removePackage("/opt/extensions/foo/index.ts", ctx, pi);
  } finally {
    restoreCatalog();
  }

  assert.deepEqual(removals, [{ source: "/opt/extensions/foo/index.ts", scope: "global" }]);
});

void test("updatePackage treats missing available updates as a no-op", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  let autoUpdateEntries: unknown[] = [];
  const restoreCatalog = mockPackageCatalog({ updates: [] });

  try {
    const { pi, ctx, entries } = createMockHarness();

    entries.push({
      type: "custom",
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 60 * 60 * 1000,
        displayText: "1 hour",
        updatesAvailable: ["npm:pi-extmgr"],
      },
    });

    await updatePackage("npm:pi-extmgr", ctx, pi);

    autoUpdateEntries = entries
      .filter((entry) => entry.customType === "extmgr-auto-update")
      .map((entry) => entry.data);
  } finally {
    restoreCatalog();
    console.log = originalLog;
  }

  assert.equal(
    output.some((line) => line.includes("Reload pi to apply changes. (Package updated.)")),
    false
  );

  const latestAutoUpdate = autoUpdateEntries[autoUpdateEntries.length - 1] as
    | { updatesAvailable?: string[] }
    | undefined;
  assert.deepEqual(latestAutoUpdate?.updatesAvailable ?? [], []);
});

void test("updatePackage reloads after a real update", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  const restoreCatalog = mockPackageCatalog({
    updates: [
      {
        source: "npm:pi-extmgr@1.0.0",
        displayName: "pi-extmgr",
        type: "npm",
        scope: "global",
      },
    ],
    updateImpl: () => undefined,
  });

  try {
    const { pi, ctx } = createMockHarness();
    await updatePackage("npm:pi-extmgr", ctx, pi);
  } finally {
    restoreCatalog();
    console.log = originalLog;
  }

  assert.equal(
    output.some((line) => line.includes("Reload pi to apply changes. (Package updated.)")),
    true
  );
});

void test("updatePackage handles update checks that fail", async () => {
  const restoreCatalog = mockPackageCatalog({
    checkForAvailableUpdatesImpl: () => {
      throw new Error("registry unavailable");
    },
  });

  try {
    const { pi, ctx, entries, notifications } = createMockHarness({ hasUI: true });

    await updatePackage("npm:pi-extmgr", ctx, pi);

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);

    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean; packageName?: string; error?: string }
      | undefined;

    assert.equal(latestHistory?.action, "package_update");
    assert.equal(latestHistory?.success, false);
    assert.equal(latestHistory?.packageName, "npm:pi-extmgr");
    assert.match(latestHistory?.error ?? "", /registry unavailable/i);
    assert.ok(
      notifications.some((entry) => entry.message.includes("Update failed: registry unavailable"))
    );
  } finally {
    restoreCatalog();
  }
});

void test("updatePackages treats no available updates as a no-op", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  let autoUpdateEntries: unknown[] = [];
  let historyEntries: unknown[] = [];
  const restoreCatalog = mockPackageCatalog({ updates: [] });

  try {
    const { pi, ctx, entries } = createMockHarness();

    entries.push({
      type: "custom",
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 60 * 60 * 1000,
        displayText: "1 hour",
        updatesAvailable: ["npm:pi-extmgr"],
      },
    });

    await updatePackages(ctx, pi);

    autoUpdateEntries = entries
      .filter((entry) => entry.customType === "extmgr-auto-update")
      .map((entry) => entry.data);
    historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);
  } finally {
    restoreCatalog();
    console.log = originalLog;
  }

  assert.equal(
    output.some((line) => line.includes("Reload pi to apply changes. (Packages updated.)")),
    false
  );

  const latestAutoUpdate = autoUpdateEntries[autoUpdateEntries.length - 1] as
    | { updatesAvailable?: string[] }
    | undefined;
  assert.deepEqual(latestAutoUpdate?.updatesAvailable ?? [], []);

  const latestHistory = historyEntries[historyEntries.length - 1] as
    | { action?: string; success?: boolean; packageName?: string }
    | undefined;
  assert.equal(latestHistory?.action, "package_update");
  assert.equal(latestHistory?.success, true);
  assert.equal(latestHistory?.packageName, "all packages");
});

void test("updatePackages handles update checks that fail", async () => {
  const restoreCatalog = mockPackageCatalog({
    checkForAvailableUpdatesImpl: () => {
      throw new Error("registry unavailable");
    },
  });

  try {
    const { pi, ctx, entries, notifications } = createMockHarness({ hasUI: true });

    await updatePackages(ctx, pi);

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);

    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean; packageName?: string; error?: string }
      | undefined;

    assert.equal(latestHistory?.action, "package_update");
    assert.equal(latestHistory?.success, false);
    assert.equal(latestHistory?.packageName, "all packages");
    assert.match(latestHistory?.error ?? "", /registry unavailable/i);
    assert.ok(
      notifications.some((entry) => entry.message.includes("Update failed: registry unavailable"))
    );
  } finally {
    restoreCatalog();
  }
});

void test("updatePackages logs failure in history", async () => {
  const restoreCatalog = mockPackageCatalog({
    updates: [
      {
        source: "npm:pi-extmgr@1.0.0",
        displayName: "pi-extmgr",
        type: "npm",
        scope: "global",
      },
    ],
    updateImpl: () => {
      throw new Error("network timeout");
    },
  });

  try {
    const { pi, ctx, entries } = createMockHarness();

    await updatePackages(ctx, pi);

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);

    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean; packageName?: string; error?: string }
      | undefined;

    assert.equal(latestHistory?.action, "package_update");
    assert.equal(latestHistory?.success, false);
    assert.equal(latestHistory?.packageName, "all packages");
    assert.match(latestHistory?.error ?? "", /network timeout/i);
  } finally {
    restoreCatalog();
  }
});

void test("installPackageLocally removes temporary extraction artifacts after success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-standalone-success-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = ((input: string | URL) => {
      const url = String(input);
      if (url !== "https://example.com/demo-pkg.tgz") {
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      }

      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      } as Response);
    }) as typeof fetch;

    const { pi, ctx, entries } = createMockHarness({
      cwd,
      execImpl: async (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              version: "1.0.0",
              dist: { tarball: "https://example.com/demo-pkg.tgz" },
            }),
            stderr: "",
            killed: false,
          };
        }

        if (command === "tar" && args[0] === "--version") {
          return { code: 0, stdout: "tar 1.0.0", stderr: "", killed: false };
        }

        if (command === "tar" && args.includes("-C")) {
          const extractDir = args[args.indexOf("-C") + 1];
          assert.ok(extractDir);

          await mkdir(extractDir, { recursive: true });
          await writeFile(
            join(extractDir, "package.json"),
            JSON.stringify({ name: "demo-pkg" }, null, 2),
            "utf8"
          );
          await writeFile(join(extractDir, "index.ts"), "// demo\n", "utf8");

          return { code: 0, stdout: "", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    await installPackageLocally("demo-pkg", ctx, pi, { scope: "project" });

    await access(join(cwd, ".pi", "extensions", "demo-pkg", "index.ts"));
    await assert.rejects(access(join(cwd, ".pi", "extensions", ".temp")));

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);
    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean }
      | undefined;

    assert.equal(latestHistory?.action, "package_install");
    assert.equal(latestHistory?.success, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("installPackageLocally rejects standalone packages with unresolved runtime dependencies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-standalone-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = ((input: string | URL) => {
      const url = String(input);
      if (url !== "https://example.com/demo-pkg.tgz") {
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      }

      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      } as Response);
    }) as typeof fetch;

    const { pi, ctx, entries } = createMockHarness({
      cwd,
      execImpl: async (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              version: "1.0.0",
              dist: { tarball: "https://example.com/demo-pkg.tgz" },
            }),
            stderr: "",
            killed: false,
          };
        }

        if (command === "tar" && args[0] === "--version") {
          return { code: 0, stdout: "tar 1.0.0", stderr: "", killed: false };
        }

        if (command === "tar" && args.includes("-C")) {
          const extractDir = args[args.indexOf("-C") + 1];
          assert.ok(extractDir);

          await mkdir(extractDir, { recursive: true });
          await writeFile(
            join(extractDir, "package.json"),
            JSON.stringify(
              {
                name: "demo-pkg",
                dependencies: { "left-pad": "1.3.0" },
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(join(extractDir, "index.ts"), "// demo\n", "utf8");

          return { code: 0, stdout: "", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    await installPackageLocally("demo-pkg", ctx, pi, { scope: "project" });

    await assert.rejects(access(join(cwd, ".pi", "extensions", "demo-pkg")));

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);
    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean }
      | undefined;

    assert.equal(latestHistory?.action, "package_install");
    assert.equal(latestHistory?.success, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("installPackageLocally fails fast with an actionable error when tar is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-standalone-"));
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  try {
    const { pi, ctx } = createMockHarness({
      cwd,
      execImpl: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              version: "1.0.0",
              dist: { tarball: "https://example.com/demo-pkg.tgz" },
            }),
            stderr: "",
            killed: false,
          };
        }

        if (command === "tar" && args[0] === "--version") {
          return { code: 127, stdout: "", stderr: "tar: not found", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    await installPackageLocally("demo-pkg", ctx, pi, { scope: "project" });

    assert.ok(output.some((line) => /tar/.test(line) && /standalone/i.test(line)));
    await assert.rejects(access(join(cwd, ".pi", "extensions", "demo-pkg")));
  } finally {
    console.log = originalLog;
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("installFromUrl aborts stalled downloads instead of hanging forever", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-url-install-"));
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number) =>
      originalSetTimeout(callback, 1)) as typeof setTimeout;

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        let settled = false;
        const fallbackTimer = originalSetTimeout(() => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error("fetch mock timeout"), { name: "TimeoutError" }));
        }, 50);

        init.signal?.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallbackTimer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as typeof fetch;

    const { pi, ctx, entries } = createMockHarness({ cwd });

    await installFromUrl("https://example.com/demo.ts", "demo.ts", ctx, pi, { scope: "project" });

    await assert.rejects(access(join(cwd, ".pi", "extensions", "demo.ts")));

    const historyEntries = entries
      .filter((entry) => entry.customType === "extmgr-change")
      .map((entry) => entry.data);
    const latestHistory = historyEntries[historyEntries.length - 1] as
      | { action?: string; success?: boolean }
      | undefined;

    assert.equal(latestHistory?.action, "package_install");
    assert.equal(latestHistory?.success, false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    await rm(cwd, { recursive: true, force: true });
  }
});
