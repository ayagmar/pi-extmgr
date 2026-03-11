import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmRegistrySearchResults } from "../src/packages/discovery.js";

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

void test("fetchNpmRegistrySearchResults paginates npm registry results beyond 250 packages", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);

    const parsedUrl = new URL(url);
    const from = Number(parsedUrl.searchParams.get("from") ?? "0");
    const payload = from === 0 ? makeSearchPage(500, 0, 250) : makeSearchPage(500, 250, 250);

    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  try {
    const results = await fetchNpmRegistrySearchResults("keywords:pi-package");

    assert.equal(results.length, 500);
    assert.equal(results[0]?.name, "pkg-0");
    assert.equal(results[499]?.name, "pkg-499");
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0]?.includes("size=250"));
    assert.ok(fetchCalls[1]?.includes("from=250"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
