import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmRegistrySearchPage, fetchNpmWeeklyDownloads } from "../src/packages/discovery.js";

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

void test("fetchNpmWeeklyDownloads batches unscoped names and points scoped names", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    // npm rejects scoped packages in bulk queries; each request shape differs.
    const body = url.includes("%40scope%2Fbeta")
      ? { package: "@scope/beta", downloads: 830 }
      : { alpha: { downloads: 12_500 }, gamma: { downloads: 77 } };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  try {
    const downloads = await fetchNpmWeeklyDownloads(["alpha", "@scope/beta", "gamma", "alpha"]);

    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every((url) => url.includes("api.npmjs.org/downloads/point/last-week/")));
    assert.ok(
      fetchCalls.some((url) => url.endsWith("/alpha,gamma")),
      "unscoped names should batch into one bulk request"
    );
    assert.ok(
      fetchCalls.some((url) => url.endsWith("/%40scope%2Fbeta")),
      "scoped names need individual point lookups"
    );
    assert.equal(downloads.get("alpha"), 12_500);
    assert.equal(downloads.get("gamma"), 77);
    assert.equal(downloads.get("@scope/beta"), 830);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("fetchNpmWeeklyDownloads returns partial results when one request fails", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("%40scope%2Fbeta")) {
      return Promise.resolve(new Response("{}", { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ package: "alpha", downloads: 41 }), { status: 200 })
    );
  }) as typeof fetch;

  try {
    const downloads = await fetchNpmWeeklyDownloads(["alpha", "@scope/beta"]);
    assert.equal(downloads.get("alpha"), 41);
    assert.equal(downloads.has("@scope/beta"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("fetchNpmWeeklyDownloads propagates aborts", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted", "AbortError"))
      );
    })) as typeof fetch;

  try {
    const pending = fetchNpmWeeklyDownloads(["alpha"], controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
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
