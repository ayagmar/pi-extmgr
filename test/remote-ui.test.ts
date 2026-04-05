import assert from "node:assert/strict";
import test from "node:test";
import { clearMetadataCacheCommand } from "../src/commands/cache.js";
import { clearSearchCache, setSearchCache } from "../src/packages/discovery.js";
import { browseRemotePackages } from "../src/ui/remote.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("browseRemotePackages honors an empty in-memory cache", async () => {
  setSearchCache({
    query: "no-results",
    results: [],
    timestamp: Date.now(),
  });

  const { pi, ctx, notifications } = createMockHarness({ hasUI: true });
  let customCalls = 0;

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = () => {
    customCalls += 1;
    return Promise.resolve(undefined);
  };

  try {
    await browseRemotePackages(ctx, "no-results", pi);

    assert.equal(customCalls, 0);
    assert.ok(
      notifications.some((entry) => entry.message.includes("No packages found for: no-results"))
    );
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages rejects local-path queries instead of showing unrelated npm results", async () => {
  const { pi, ctx, notifications } = createMockHarness({ hasUI: true });
  let customCalls = 0;

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = () => {
    customCalls += 1;
    return Promise.resolve(undefined);
  };

  try {
    await browseRemotePackages(
      ctx,
      "/tmp/pi-clipboard-32423307-5cb5-418f-b6c5-dcb344d4a627.png",
      pi
    );

    assert.equal(customCalls, 0);
    assert.ok(
      notifications.some(
        (entry) =>
          entry.message.includes("looks like a local path") &&
          entry.message.includes("Install by source")
      )
    );
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages shows inline search affordances in the browse UI", async () => {
  setSearchCache({
    query: "demo",
    results: [
      {
        name: "demo-pkg",
        version: "1.0.0",
        description: "Demo package",
      },
    ],
    timestamp: Date.now(),
  });

  const { pi, ctx } = createMockHarness({ hasUI: true });
  let renderedLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, (_component, lines) => {
      renderedLines = lines;
      return { type: "cancel" };
    });

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.ok(renderedLines.some((line) => line.includes("/ search")));
    assert.ok(renderedLines.some((line) => line.includes("page 1/1")));
    assert.ok(renderedLines.some((line) => line.includes("demo-pkg@1.0.0")));
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages supports next-page navigation from search results", async () => {
  setSearchCache({
    query: "demo",
    results: Array.from({ length: 25 }, (_, index) => ({
      name: `demo-pkg-${index + 1}`,
      version: "1.0.0",
      description: `Demo package ${index + 1}`,
    })),
    timestamp: Date.now(),
  });

  const { pi, ctx } = createMockHarness({ hasUI: true });
  let customCalls = 0;
  let secondPageLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) => {
    customCalls += 1;

    if (customCalls === 1) {
      return captureCustomComponent(factory, ctx.ui.theme, (component, _lines, completion) => {
        component.handleInput?.("n");
        return completion;
      });
    }

    return captureCustomComponent(factory, ctx.ui.theme, (_component, lines) => {
      secondPageLines = lines;
      return { type: "cancel" };
    });
  };

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.equal(customCalls, 2);
    assert.ok(secondPageLines.some((line) => line.includes("21-25 of 25")));
    assert.ok(secondPageLines.some((line) => line.includes("page 2/2")));
    assert.ok(secondPageLines.some((line) => line.includes("demo-pkg-21@1.0.0")));
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages can start a new remote npm search from search results", async () => {
  setSearchCache({
    query: "demo",
    results: [
      {
        name: "browse-default",
        version: "1.0.0",
        description: "Default browse result",
      },
    ],
    timestamp: Date.now(),
  });

  const nextQuery = "inline-demo";
  const { pi, ctx } = createMockHarness({ hasUI: true });
  let customCalls = 0;
  let searchedLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) => {
    customCalls += 1;

    if (customCalls === 1) {
      return captureCustomComponent(factory, ctx.ui.theme, (component, _lines, completion) => {
        component.handleInput?.("/");
        for (const char of nextQuery) {
          component.handleInput?.(char);
        }
        setSearchCache({
          query: nextQuery,
          results: [
            {
              name: "inline-result",
              version: "2.0.0",
              description: "Inline search result",
            },
          ],
          timestamp: Date.now(),
        });
        component.handleInput?.("\r");
        return completion;
      });
    }

    return captureCustomComponent(factory, ctx.ui.theme, (_component, lines) => {
      searchedLines = lines;
      return { type: "cancel" };
    });
  };

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.equal(customCalls, 2);
    assert.ok(searchedLines.some((line) => line.includes("Search: inline-demo")));
    assert.ok(searchedLines.some((line) => line.includes("inline-result@2.0.0")));
  } finally {
    clearSearchCache();
  }
});

void test("browseRemotePackages filters community packages locally from the browse UI", async () => {
  setSearchCache({
    query: "keywords:pi-package",
    results: [
      {
        name: "browse-default",
        version: "1.0.0",
        description: "Default browse result",
        author: "someone",
      },
      {
        name: "pi-copilot-queue",
        version: "2.0.0",
        description: "Queue tools for Pi copilots",
        author: "ayagmar",
        keywords: ["pi-package", "queue", "copilot"],
      },
    ],
    timestamp: Date.now(),
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  }) as typeof fetch;

  const nextQuery = "copilot queue";
  const { pi, ctx } = createMockHarness({ hasUI: true });
  let customCalls = 0;
  let searchedLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) => {
    customCalls += 1;

    if (customCalls === 1) {
      return captureCustomComponent(factory, ctx.ui.theme, (component, _lines, completion) => {
        component.handleInput?.("/");
        for (const char of nextQuery) {
          component.handleInput?.(char);
        }
        component.handleInput?.("\r");
        return completion;
      });
    }

    return captureCustomComponent(factory, ctx.ui.theme, (_component, lines) => {
      searchedLines = lines;
      return { type: "cancel" };
    });
  };

  try {
    await browseRemotePackages(ctx, "keywords:pi-package", pi);

    assert.equal(customCalls, 2);
    assert.equal(fetchCalls, 0);
    assert.ok(searchedLines.some((line) => line.includes("Search: copilot queue")));
    assert.ok(searchedLines.some((line) => line.includes("pi-copilot-queue@2.0.0")));
    assert.ok(!searchedLines.some((line) => line.includes("browse-default@1.0.0")));
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browseRemotePackages ranks community matches locally and shows author in details", async () => {
  setSearchCache({
    query: "keywords:pi-package",
    results: [
      {
        name: "alpha-tool",
        version: "1.0.0",
        description: "Queue utilities for Pi",
        author: "someone",
      },
      {
        name: "queue-copilot",
        version: "2.0.0",
        description: "Copilot queue tools",
        author: "ayagmar",
      },
    ],
    timestamp: Date.now(),
  });

  const { pi, ctx } = createMockHarness({ hasUI: true });
  let renderedLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, (_component, lines) => {
      renderedLines = lines;
      return { type: "cancel" };
    });

  try {
    await browseRemotePackages(ctx, "queue", pi, 0, "community");

    const bestMatchIndex = renderedLines.findIndex((line) => line.includes("queue-copilot@2.0.0"));
    const secondaryMatchIndex = renderedLines.findIndex((line) =>
      line.includes("alpha-tool@1.0.0")
    );

    assert.ok(bestMatchIndex >= 0);
    assert.ok(secondaryMatchIndex >= 0);
    assert.ok(bestMatchIndex < secondaryMatchIndex);
    assert.ok(renderedLines.some((line) => line.includes("by ayagmar")));
  } finally {
    clearSearchCache();
  }
});

void test("clearMetadataCacheCommand clears the community browse runtime cache", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls += 1;
    assert.ok(url.includes("registry.npmjs.org/-/v1/search"));

    return Promise.resolve(
      new Response(
        JSON.stringify({
          total: 1,
          objects: [
            {
              package: {
                name: "pi-copilot-queue",
                version: "1.0.0",
                description: "Queue tools for Pi",
                keywords: ["pi-package", "queue"],
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

  const { pi, ctx } = createMockHarness({ hasUI: true });
  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, (_component, lines, completion) => {
      if (lines.some((line) => line.includes("/ search"))) {
        return { type: "cancel" };
      }
      return completion;
    });

  try {
    await browseRemotePackages(ctx, "keywords:pi-package", pi);
    assert.equal(fetchCalls, 1);

    setSearchCache({
      query: "demo",
      results: [{ name: "demo-pkg", description: "Demo package" }],
      timestamp: Date.now(),
    });

    await clearMetadataCacheCommand(ctx, pi);
    await browseRemotePackages(ctx, "keywords:pi-package", pi);

    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browseRemotePackages returns to results after installing from package details", async () => {
  const restoreCatalog = mockPackageCatalog();
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
                name: "demo-pkg",
                version: "1.0.0",
                description: "Demo package",
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

  const { pi, ctx, confirmPrompts, selectPrompts } = createMockHarness({
    hasUI: true,
    confirmImpl: (title) => title === "Install Package",
  });
  const selectResults = ["Install via npm (managed)", "Global (~/.pi/agent/settings.json)"];
  let browserCalls = 0;
  let returnedLines: string[] = [];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = (factory) =>
    captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
      if (!lines.some((line) => line.includes("/ search"))) {
        return completion;
      }

      browserCalls += 1;
      if (browserCalls === 1) {
        component.handleInput?.("\r");
        return completion;
      }

      returnedLines = lines;
      return { type: "cancel" };
    });

  (ctx.ui as { select: (title: string, items?: string[]) => Promise<string | undefined> }).select =
    (title) => {
      selectPrompts.push(title);
      return Promise.resolve(selectResults.shift());
    };

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.equal(browserCalls, 2);
    assert.ok(returnedLines.some((line) => line.includes("demo-pkg@1.0.0")));
    assert.ok(selectPrompts.includes("demo-pkg"));
    assert.ok(selectPrompts.includes("Install scope"));
    assert.ok(confirmPrompts.includes("Reload Required"));
  } finally {
    restoreCatalog();
    globalThis.fetch = originalFetch;
    clearSearchCache();
  }
});

void test("browseRemotePackages returns to package details after a cancelled load", async () => {
  setSearchCache({
    query: "demo",
    results: [
      {
        name: "demo-pkg",
        version: "1.0.0",
        description: "Demo package",
      },
    ],
    timestamp: Date.now(),
  });

  const { pi, ctx, notifications, selectPrompts } = createMockHarness({ hasUI: true });
  const customResults: unknown[] = [
    { type: "package", name: "demo-pkg" },
    undefined,
    { type: "cancel" },
  ];
  const selectResults = ["View npm info", "Back to results"];

  (
    ctx.ui as unknown as {
      custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    }
  ).custom = () => Promise.resolve(customResults.shift());
  (ctx.ui as { select: (title: string, items?: string[]) => Promise<string | undefined> }).select =
    (title) => {
      selectPrompts.push(title);
      return Promise.resolve(selectResults.shift());
    };

  try {
    await browseRemotePackages(ctx, "demo", pi);

    assert.equal(selectPrompts.filter((title) => title === "demo-pkg").length, 2);
    assert.ok(
      notifications.some((entry) =>
        entry.message.includes("Loading demo-pkg details was cancelled.")
      )
    );
  } finally {
    clearSearchCache();
  }
});
