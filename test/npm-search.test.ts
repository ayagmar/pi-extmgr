import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmRegistrySearchPage } from "../src/packages/discovery.js";

function makeSearchPage(total: number, from: number, count: number) {
  return {
    total,
    objects: Array.from({ length: count }, (_, index) => {
      const id = from + index;
      return {
        package: {
          name: `pkg-${id}`,
          version: "1.0.0",
          description: `package ${id}`,
          keywords: ["pi-package"],
          date: "2026-03-11T00:00:00.000Z",
        },
      };
    }),
  };
}

void test("fetchNpmRegistrySearchPage only requests the visible registry page", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);

    return Promise.resolve(
      new Response(JSON.stringify(makeSearchPage(5_000, 40, 20)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  try {
    const page = await fetchNpmRegistrySearchPage("keywords:pi-package", 40);

    assert.equal(page.results.length, 20);
    assert.equal(page.results[0]?.name, "pkg-40");
    assert.equal(page.results[19]?.name, "pkg-59");
    assert.equal(page.total, 5_000);
    assert.equal(page.offset, 40);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0]?.includes("size=20"));
    assert.ok(fetchCalls[0]?.includes("from=40"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("fetchNpmRegistrySearchPage retries HTTP 429 using Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = (() => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return Promise.resolve(
        new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify(makeSearchPage(1, 0, 1)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  try {
    const page = await fetchNpmRegistrySearchPage("demo");

    assert.equal(fetchCalls, 2);
    assert.equal(page.results[0]?.name, "pkg-0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("fetchNpmRegistrySearchPage reports a useful error after repeated HTTP 429 responses", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
    )) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchNpmRegistrySearchPage("demo"),
      /rate-limited \(HTTP 429\).*Try again shortly/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("fetchNpmRegistrySearchPage prefers maintainer usernames over publisher emails", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.includes("registry.npmjs.org/-/v1/search"));

    return Promise.resolve(
      new Response(
        JSON.stringify({
          total: 1,
          objects: [
            {
              package: {
                name: "demo-author",
                version: "1.0.0",
                publisher: { email: "publisher@example.com" },
                maintainers: [
                  { email: "fallback@example.com" },
                  { username: "preferred-user", email: "preferred@example.com" },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
  }) as typeof fetch;

  try {
    const page = await fetchNpmRegistrySearchPage("demo-author");
    assert.equal(page.results[0]?.author, "preferred-user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
