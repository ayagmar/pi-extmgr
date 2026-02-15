import test from "node:test";
import assert from "node:assert/strict";
import { installPackage } from "../src/packages/install.js";
import { removePackage } from "../src/packages/management.js";
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
