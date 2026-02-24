import test from "node:test";
import assert from "node:assert/strict";
import { installPackage } from "../src/packages/install.js";
import { removePackage, updatePackage, updatePackages } from "../src/packages/management.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("installPackage calls pi install with normalized npm source", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await installPackage("pi-extmgr", ctx, pi);

  const installCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "install");
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0]?.command, "pi");
  assert.deepEqual(installCalls[0]?.args, ["install", "npm:pi-extmgr"]);
});

void test("installPackage normalizes git@ sources to git: prefix", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await installPackage("git@github.com:user/repo.git", ctx, pi);

  const installCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "install");
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0]?.command, "pi");
  assert.deepEqual(installCalls[0]?.args, ["install", "git:git@github.com:user/repo.git"]);
});

void test("removePackage calls pi remove", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await removePackage("npm:pi-extmgr", ctx, pi);

  const removeCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "remove");
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0]?.args, ["remove", "npm:pi-extmgr"]);
});

void test("removePackage does not request reload when removal fails", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  try {
    const { pi, ctx } = createMockHarness({
      execImpl: (command, args) => {
        if (command === "pi" && args[0] === "list") {
          return {
            code: 0,
            stdout: "Global:\n  npm:pi-extmgr\n",
            stderr: "",
            killed: false,
          };
        }

        if (command === "pi" && args[0] === "remove") {
          return {
            code: 1,
            stdout: "",
            stderr: "permission denied",
            killed: false,
          };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    await removePackage("npm:pi-extmgr", ctx, pi);
  } finally {
    console.log = originalLog;
  }

  assert.equal(
    output.some((line) => line.includes("Reload pi to apply changes. (Removal complete.)")),
    false
  );
});

void test("removePackage targets exact local source when names collide", async () => {
  const installed = ["/opt/extensions/alpha/index.ts", "/opt/extensions/beta/index.ts"];

  const { pi, ctx, calls } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        const lines = ["Global:", ...installed.map((source) => `  ${source}`), ""];
        return {
          code: 0,
          stdout: lines.join("\n"),
          stderr: "",
          killed: false,
        };
      }

      if (command === "pi" && args[0] === "remove") {
        const source = args[1];
        const index = installed.indexOf(source ?? "");
        if (index >= 0) installed.splice(index, 1);
        return { code: 0, stdout: "Removed", stderr: "", killed: false };
      }

      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  });

  await removePackage("/opt/extensions/beta/index.ts", ctx, pi);

  const removeCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "remove");
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0]?.args, ["remove", "/opt/extensions/beta/index.ts"]);
});

void test("removePackage keeps case-sensitive local paths distinct", async () => {
  const installed = ["/opt/extensions/Foo/index.ts", "/opt/extensions/foo/index.ts"];

  const { pi, ctx, calls } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "list") {
        const lines = ["Global:", ...installed.map((source) => `  ${source}`), ""];
        return {
          code: 0,
          stdout: lines.join("\n"),
          stderr: "",
          killed: false,
        };
      }

      if (command === "pi" && args[0] === "remove") {
        const source = args[1];
        const index = installed.indexOf(source ?? "");
        if (index >= 0) installed.splice(index, 1);
        return { code: 0, stdout: "Removed", stderr: "", killed: false };
      }

      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  });

  await removePackage("/opt/extensions/foo/index.ts", ctx, pi);

  const removeCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "remove");
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0]?.args, ["remove", "/opt/extensions/foo/index.ts"]);
});

void test("updatePackage treats case-variant already-up-to-date output as no-op", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  let autoUpdateEntries: unknown[] = [];

  try {
    const { pi, ctx, entries } = createMockHarness({
      execImpl: (command, args) => {
        if (command === "pi" && args[0] === "update") {
          return {
            code: 0,
            stdout: "Already up to date",
            stderr: "",
            killed: false,
          };
        }

        if (command === "pi" && args[0] === "list") {
          return { code: 0, stdout: "No packages installed", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    entries.push({
      type: "custom",
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 60 * 60 * 1000,
        displayText: "1 hour",
        updatesAvailable: ["pi-extmgr"],
      },
    });

    await updatePackage("npm:pi-extmgr", ctx, pi);

    autoUpdateEntries = entries
      .filter((entry) => entry.customType === "extmgr-auto-update")
      .map((entry) => entry.data);
  } finally {
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

void test("updatePackages treats case-variant already-up-to-date output as no-op", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };

  let autoUpdateEntries: unknown[] = [];
  let historyEntries: unknown[] = [];

  try {
    const { pi, ctx, entries } = createMockHarness({
      execImpl: (command, args) => {
        if (command === "pi" && args[0] === "update") {
          return {
            code: 0,
            stdout: "All packages are Already Up To Date",
            stderr: "",
            killed: false,
          };
        }

        if (command === "pi" && args[0] === "list") {
          return { code: 0, stdout: "No packages installed", stderr: "", killed: false };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    entries.push({
      type: "custom",
      customType: "extmgr-auto-update",
      data: {
        enabled: true,
        intervalMs: 60 * 60 * 1000,
        displayText: "1 hour",
        updatesAvailable: ["pi-extmgr"],
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

void test("updatePackages logs failure in history", async () => {
  const { pi, ctx, entries } = createMockHarness({
    execImpl: (command, args) => {
      if (command === "pi" && args[0] === "update") {
        return { code: 1, stdout: "", stderr: "network timeout", killed: false };
      }

      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  });

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
});
