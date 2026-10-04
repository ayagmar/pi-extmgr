import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearReloadRequired,
  markReloadRequired,
  readReloadState,
} from "../src/utils/reload-state.js";
import { confirmReload } from "../src/utils/ui-helpers.js";

void test("reload-required state is versioned, atomic, and coalesces reasons", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-"));
  const path = join(dir, "reload.json");
  try {
    await Promise.all([
      markReloadRequired("Package installed", path),
      markReloadRequired("Package installed", path),
      markReloadRequired("Extension toggled", path),
    ]);

    const state = await readReloadState(path);
    assert.equal(state.version, 1);
    assert.equal(state.required, true);
    assert.equal(state.changes, 3);
    assert.deepEqual(state.reasons, ["Package installed", "Extension toggled"]);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);

    await clearReloadRequired(path);
    assert.deepEqual(await readReloadState(path), {
      version: 1,
      required: false,
      changes: 0,
      reasons: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("declining an interactive reload keeps the successful mutation pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-declined-"));
  const path = join(dir, "reload.json");
  try {
    let reloads = 0;
    const reloaded = await confirmReload(
      {
        hasUI: true,
        ui: { confirm: async () => false },
        reload: async () => {
          reloads += 1;
        },
      } as never,
      "Package installed.",
      path
    );

    assert.equal(reloaded, false);
    assert.equal(reloads, 0);
    const state = await readReloadState(path);
    assert.equal(state.version, 1);
    assert.equal(state.required, true);
    assert.equal(typeof state.changedAt, "number");
    assert.equal(state.changes, 1);
    assert.deepEqual(state.reasons, ["Package installed."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a successful interactive reload clears the pending marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-success-"));
  const path = join(dir, "reload.json");
  try {
    const reloaded = await confirmReload(
      {
        hasUI: true,
        ui: { confirm: async () => true },
        reload: async () => undefined,
      } as never,
      "Extension changed.",
      path
    );

    assert.equal(reloaded, true);
    assert.deepEqual(await readReloadState(path), {
      version: 1,
      required: false,
      changes: 0,
      reasons: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("reload-required state ignores malformed persisted data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-invalid-"));
  const path = join(dir, "reload.json");
  try {
    await writeFile(path, "{invalid", "utf8");
    assert.deepEqual(await readReloadState(path), {
      version: 1,
      required: false,
      changes: 0,
      reasons: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a failed reload-state write does not wedge later writes and reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-reload-failed-write-"));
  const blocker = join(dir, "not-a-directory");
  const path = join(dir, "reload.json");
  try {
    // The parent of this path is a regular file, so the write must fail.
    await writeFile(blocker, "", "utf8");
    await assert.rejects(markReloadRequired("Unwritable", join(blocker, "reload.json")));

    await markReloadRequired("Package installed", path);
    const state = await readReloadState(path);
    assert.equal(state.required, true);
    assert.deepEqual(state.reasons, ["Package installed"]);

    await clearReloadRequired(path);
    assert.equal((await readReloadState(path)).required, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
