import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CACHE_LIMITS } from "../src/constants.js";

void test("metadata cache merges partial package updates without discarding richer fields", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-cache-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;

  try {
    process.env.PI_EXTMGR_CACHE_DIR = cacheDir;

    const cache = (await import(
      `../src/utils/cache.ts?cache-merge=${Date.now()}`
    )) as typeof import("../src/utils/cache.js");

    await cache.clearCache();
    await cache.setCachedPackageSize("demo", 2048);
    await cache.setCachedSearch("keywords:pi-package", [
      {
        name: "demo",
        description: "original description",
        author: "ayagmar",
        keywords: ["pi-package", "queue"],
        date: "2026-04-04T00:00:00.000Z",
      },
    ]);

    await cache.setCachedPackage("demo", {
      name: "demo",
      description: "updated description",
    });

    const cached = await cache.getCachedPackage("demo");

    assert.equal(cached?.description, "updated description");
    assert.equal(cached?.author, "ayagmar");
    assert.deepEqual(cached?.keywords, ["pi-package", "queue"]);
    assert.equal(cached?.date, "2026-04-04T00:00:00.000Z");
    assert.equal(cached?.size, 2048);
  } finally {
    if (previousCacheDir === undefined) {
      delete process.env.PI_EXTMGR_CACHE_DIR;
    } else {
      process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    }
    await rm(cacheDir, { recursive: true, force: true });
  }
});

void test("metadata cache keeps inherited fields on their original TTL", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-cache-ttl-"));
  const previousCacheDir = process.env.PI_EXTMGR_CACHE_DIR;
  const originalNow = Date.now;
  let now = 1;

  try {
    process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
    Date.now = () => now;

    const cache = (await import(
      `../src/utils/cache.ts?cache-ttl=${Math.random()}`
    )) as typeof import("../src/utils/cache.js");

    await cache.clearCache();
    await cache.setCachedPackageSize("demo", 2048);

    now += 1_000;
    await cache.setCachedPackage("demo", {
      name: "demo",
      description: "fresh description",
    });

    now = CACHE_LIMITS.metadataTTL + 500;

    const cached = await cache.getCachedPackage("demo");
    const size = await cache.getCachedPackageSize("demo");

    assert.equal(cached?.description, "fresh description");
    assert.equal(size, undefined);
    assert.equal(cached?.size, undefined);
  } finally {
    Date.now = originalNow;
    if (previousCacheDir === undefined) {
      delete process.env.PI_EXTMGR_CACHE_DIR;
    } else {
      process.env.PI_EXTMGR_CACHE_DIR = previousCacheDir;
    }
    await rm(cacheDir, { recursive: true, force: true });
  }
});
