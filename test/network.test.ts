import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout } from "../src/utils/network.js";

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
