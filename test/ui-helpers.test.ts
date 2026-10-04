import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readReloadState } from "../src/utils/reload-state.js";
import { confirmReload, reloadNow, wasContextReloaded } from "../src/utils/ui-helpers.js";

/** A command context that pi retires (every access throws) once reload() runs. */
function retiringContext(overrides: Record<string, unknown> = {}): ExtensionCommandContext {
  let retired = false;
  const target: Record<string, unknown> = {
    hasUI: true,
    ui: { confirm: () => Promise.resolve(true), notify: () => undefined },
    reload: () => {
      retired = true;
      return Promise.resolve();
    },
    ...overrides,
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (retired)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      return Reflect.get(object, property, receiver);
    },
  }) as unknown as ExtensionCommandContext;
}

void test("confirmReload marks a context stale after a successful reload", async () => {
  const ctx = retiringContext();

  assert.equal(await confirmReload(ctx, "Package updated."), true);
  assert.equal(wasContextReloaded(ctx), true);
});

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

void test("reloadNow swallows a failure reported on an already retired context", async () => {
  let retired = false;
  const ctx = {
    get ui() {
      if (retired)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      return { notify: () => undefined };
    },
    reload: () => {
      retired = true;
      return Promise.reject(new Error("extension failed to load"));
    },
  } as unknown as ExtensionCommandContext;

  assert.equal(await reloadNow(ctx), false);
  assert.equal(wasContextReloaded(ctx), false);
});

void test("reloadNow reports no reload when pi declines it and keeps the marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-declined-"));
  const path = join(dir, "reload.json");
  try {
    // pi's TUI resolves reload() without reloading while a response is streaming.
    let reloads = 0;
    const ctx = {
      hasUI: true,
      ui: { confirm: () => Promise.resolve(true), notify: () => undefined },
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    } as unknown as ExtensionCommandContext;

    assert.equal(await confirmReload(ctx, "Package installed.", path), false);
    assert.equal(reloads, 1);
    assert.equal(wasContextReloaded(ctx), false);
    assert.equal((await readReloadState(path)).required, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("reloadNow waits for an idle session instead of asking pi to reload", async () => {
  const notifications: { message: string; level: string | undefined }[] = [];
  let reloads = 0;
  const ctx = {
    hasUI: true,
    isIdle: () => false,
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
    reload: () => {
      reloads += 1;
      return Promise.resolve();
    },
  } as unknown as ExtensionCommandContext;

  assert.equal(await reloadNow(ctx), false);
  assert.equal(reloads, 0);
  assert.equal(wasContextReloaded(ctx), false);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message ?? "", /current response finishes/);
});

void test("reloadNow reports a reload once pi retires the context", async () => {
  const ctx = retiringContext({ isIdle: () => true });
  assert.equal(await reloadNow(ctx), true);
  assert.equal(wasContextReloaded(ctx), true);
});
