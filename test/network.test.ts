import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadToFile, fetchWithTimeout } from "../src/utils/network.js";

void test("fetchWithTimeout enforces the timeout while reading the response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(new TextEncoder().encode("late")), 100);
      },
    });
    return Promise.resolve(new Response(body));
  }) as typeof fetch;

  try {
    await assert.rejects(() => fetchWithTimeout("https://example.test", 10), /timed out after 1s/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("downloadToFile accepts bounded streams", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-download-"));
  const destination = join(dir, "archive.tgz");
  globalThis.fetch = (() =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
  try {
    await downloadToFile("https://example.test/archive", destination, 1_000, 3);
    assert.deepEqual(new Uint8Array(await readFile(destination)), new Uint8Array([1, 2, 3]));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("downloadToFile rejects declared and streamed overflow and cleans partial files", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-download-"));
  const destination = join(dir, "archive.tgz");
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1]), { headers: { "content-length": "4" } })
      )) as typeof fetch;
    await assert.rejects(
      () => downloadToFile("https://example.test/archive", destination, 1_000, 3),
      /exceeds/
    );
    await assert.rejects(access(destination));

    globalThis.fetch = (() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])))) as typeof fetch;
    await assert.rejects(
      () => downloadToFile("https://example.test/archive", destination, 1_000, 3),
      /exceeds/
    );
    await assert.rejects(access(destination));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("downloadToFile honors cancellation and removes partial files", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "pi-extmgr-download-"));
  const destination = join(dir, "archive.tgz");
  const controller = new AbortController();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array([1]));
            setTimeout(() => stream.enqueue(new Uint8Array([2])), 10);
          },
        })
      )
    )) as typeof fetch;
  try {
    const pending = downloadToFile(
      "https://example.test/archive",
      destination,
      1_000,
      10,
      controller.signal
    );
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(access(destination));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("fetchWithTimeout preserves caller cancellation while reading the body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(new TextEncoder().encode("late")), 100);
      },
    });
    return Promise.resolve(new Response(body));
  }) as typeof fetch;
  const controller = new AbortController();

  try {
    const pending = fetchWithTimeout("https://example.test", 1_000, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
