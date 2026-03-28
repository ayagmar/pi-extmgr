import assert from "node:assert/strict";
import test from "node:test";
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

  assert.deepEqual(remote, { id: "remote", args: [] });
  assert.deepEqual(remove, { id: "remove", args: ["npm:demo"] });
});

void test("autocomplete includes base commands and aliases", () => {
  const remoteItems = getExtensionsAutocompleteItems("pack") ?? [];
  assert.ok(remoteItems.some((item) => item.value === "packages"));

  const removeItems = getExtensionsAutocompleteItems("unins") ?? [];
  assert.ok(removeItems.some((item) => item.value === "uninstall"));
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
