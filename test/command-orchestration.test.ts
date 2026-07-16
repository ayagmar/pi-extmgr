import assert from "node:assert/strict";
import test from "node:test";
import { setLocalCompletionIndexForTests } from "../src/commands/completion.js";
import {
  getExtensionsAutocompleteItems,
  resolveCommand,
  runResolvedCommand,
} from "../src/commands/registry.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("resolveCommand defaults to local when no args are provided", () => {
  const resolved = resolveCommand([]);
  assert.deepEqual(resolved, { id: "local", args: [] });
});

void test("resolveCommand maps aliases to command ids", () => {
  const remote = resolveCommand(["packages"]);
  const remove = resolveCommand(["uninstall", "npm:demo"]);
  const doctor = resolveCommand(["doctor"]);

  assert.deepEqual(remote, { id: "remote", args: [] });
  assert.deepEqual(remove, { id: "remove", args: ["npm:demo"] });
  assert.deepEqual(doctor, { id: "doctor", args: [] });
});

void test("autocomplete includes base commands and aliases", () => {
  const remoteItems = getExtensionsAutocompleteItems("pack") ?? [];
  assert.ok(remoteItems.some((item) => item.value === "packages"));

  const removeItems = getExtensionsAutocompleteItems("unins") ?? [];
  assert.ok(removeItems.some((item) => item.value === "uninstall"));
});

void test("autocomplete offers static command arguments without network requests", () => {
  assert.deepEqual(
    getExtensionsAutocompleteItems("install --p")?.map((item) => item.value),
    ["--project"]
  );
  assert.deepEqual(
    getExtensionsAutocompleteItems("history --f")?.map((item) => item.value),
    ["--failed"]
  );
});

void test("autocomplete uses only preloaded package and profile names", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("autocomplete must not use the network");
  }) as typeof fetch;
  setLocalCompletionIndexForTests({
    installedPackages: ["npm:alpha", "git:https://example.com/team/demo.git@main"],
    savedProfiles: ["team", "workstation"],
  });
  try {
    assert.deepEqual(
      getExtensionsAutocompleteItems("remove npm:a")?.map((item) => item.value),
      ["npm:alpha"]
    );
    assert.deepEqual(
      getExtensionsAutocompleteItems("update git:")?.map((item) => item.value),
      ["git:https://example.com/team/demo.git@main"]
    );
    assert.deepEqual(
      getExtensionsAutocompleteItems("profile apply te")?.map((item) => item.value),
      ["team"]
    );
    assert.deepEqual(
      getExtensionsAutocompleteItems("history --action package_r")?.map((item) => item.value),
      ["package_remove"]
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    setLocalCompletionIndexForTests();
  }
});

void test("runResolvedCommand install respects --project scope", async () => {
  const installs: { source: string; scope: "global" | "project" }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx } = createMockHarness();
    await runResolvedCommand({ id: "install", args: ["pi-extmgr", "--project"] }, ctx, pi);

    assert.deepEqual(installs, [{ source: "npm:pi-extmgr", scope: "project" }]);
  } finally {
    restoreCatalog();
  }
});

void test("runResolvedCommand install rejects conflicting scope flags", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await runResolvedCommand(
    { id: "install", args: ["npm:pi-extmgr", "--project", "--global"] },
    ctx,
    pi
  );

  const installCalls = calls.filter((c) => c.command === "pi" && c.args[0] === "install");
  assert.equal(installCalls.length, 0);
});
