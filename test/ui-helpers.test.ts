import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { confirmReload } from "../src/utils/ui-helpers.js";

void test("confirmReload notifies the user when ctx.reload rejects", async () => {
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
