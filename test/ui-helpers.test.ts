import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { confirmReload } from "../src/utils/ui-helpers.js";

void test("confirmReload returns false without reloading when user cancels", async () => {
  const notifications: { message: string; level: string | undefined }[] = [];
  let reloadCalls = 0;
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => Promise.resolve(false),
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
    reload: () => {
      reloadCalls += 1;
      return Promise.resolve();
    },
  } as unknown as ExtensionCommandContext;

  const reloaded = await confirmReload(ctx, "Package updated.");

  assert.equal(reloaded, false);
  assert.equal(reloadCalls, 0);
  assert.deepEqual(notifications, []);
});

void test("confirmReload returns true after a successful reload", async () => {
  const notifications: { message: string; level: string | undefined }[] = [];
  let reloadCalls = 0;
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => Promise.resolve(true),
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
    reload: () => {
      reloadCalls += 1;
      return Promise.resolve();
    },
  } as unknown as ExtensionCommandContext;

  const reloaded = await confirmReload(ctx, "Package updated.");

  assert.equal(reloaded, true);
  assert.equal(reloadCalls, 1);
  assert.deepEqual(notifications, []);
});

void test("confirmReload reports reload failures without throwing", async () => {
  const notifications: { message: string; level: string | undefined }[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => Promise.resolve(true),
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
    reload: () => Promise.reject(new Error("npm install -g pi-extmgr failed with code 243")),
  } as unknown as ExtensionCommandContext;

  const reloaded = await confirmReload(ctx, "Package updated.");

  assert.equal(reloaded, false);
  assert.deepEqual(notifications, [
    {
      message: "Reload failed: npm install -g pi-extmgr failed with code 243",
      level: "error",
    },
  ]);
});
