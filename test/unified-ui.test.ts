import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { showInteractive } from "../src/ui/unified.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

void test("/extensions keeps rows compact and moves selected details below the list", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-ui-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");
  const summary = "Focused detail text should stay below the list, not inline with every row.";

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-focus.ts"), `// ${summary}\n`, "utf8");
    await writeFile(join(projectExtensionsRoot, "beta-focus.ts"), "// Secondary row\n", "utf8");

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let renderedLines: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (_component, lines) => {
          renderedLines = lines;
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    const rowLine = renderedLines.find(
      (line) => line.includes("● [P]") && line.includes("alpha-focus.ts")
    );
    assert.ok(rowLine, "expected compact local extension row");
    assert.ok(!rowLine.includes(summary), "row should not inline the full summary");
    assert.ok(
      renderedLines.some((line) => line.includes(summary)),
      "expected selected extension summary in the details area"
    );
    assert.ok(
      renderedLines.some((line) => line.includes("Space toggle")),
      "expected contextual actions in the manager footer"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions groups local extensions and packages into sections", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-groups-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo-group@1.0.0",
        name: "demo-group",
        version: "1.0.0",
        scope: "global",
      },
    ],
  });

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-group.ts"), "// alpha\n", "utf8");

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let renderedLines: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("/ search")),
        (_component, lines) => {
          renderedLines = lines;
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(
      renderedLines.some((line) => line.includes("Local extensions (")),
      "expected local section header"
    );
    assert.ok(
      renderedLines.some((line) => line.includes("Installed packages (")),
      "expected package section header"
    );
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions shows package sizes inline when known", async () => {
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo-pkg@1.2.3",
        name: "demo-pkg",
        version: "1.2.3",
        scope: "global",
        description: "Demo package",
        size: 115712,
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness({ cwd: "/tmp", hasUI: true });
    let renderedLines: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (_component, lines) => {
          renderedLines = lines;
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(
      renderedLines.some((line) => line.includes("demo-pkg@1.2.3") && line.includes("113 KB")),
      "expected known package size to be visible inline"
    );
  } finally {
    restoreCatalog();
  }
});

void test("/extensions uses Enter for local actions instead of toggling state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-enter-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-enter.ts"), "// alpha\n", "utf8");

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let rawAction: unknown;

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (component, _lines, completion) => {
          component.handleInput?.("\r");
          return completion.then((value) => {
            rawAction = value;
            return { type: "cancel" };
          });
        }
      );

    await showInteractive(ctx, pi);

    assert.deepEqual(rawAction, {
      type: "action",
      itemId:
        rawAction && typeof rawAction === "object" ? (rawAction as { itemId: string }).itemId : "",
      action: "menu",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions searches visible items only after activating search", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-search-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-search.ts"), "// alpha\n", "utf8");
    await writeFile(join(projectExtensionsRoot, "beta-search.ts"), "// beta\n", "utf8");

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let afterSearch: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("/ search")),
        (component) => {
          component.handleInput?.("/");
          component.handleInput?.("b");
          component.handleInput?.("e");
          component.handleInput?.("t");
          component.handleInput?.("a");
          component.handleInput?.("\r");
          afterSearch = component.render(120);
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(afterSearch.some((line) => line.includes("beta-search.ts")));
    assert.ok(!afterSearch.some((line) => line.includes("alpha-search.ts")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions filters packages with the quick filter shortcuts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-filter-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:demo-filter@1.0.0",
        name: "demo-filter",
        version: "1.0.0",
        scope: "global",
      },
    ],
  });

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-filter.ts"), "// alpha\n", "utf8");

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let filteredLines: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("/ search")),
        (component) => {
          component.handleInput?.("3");
          filteredLines = component.render(120);
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(filteredLines.some((line) => line.includes("Installed packages (1)")));
    assert.ok(!filteredLines.some((line) => line.includes("Local extensions (1)")));
    assert.ok(filteredLines.some((line) => line.includes("demo-filter@1.0.0")));
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions still toggles local items with Space", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-unified-space-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    await writeFile(join(projectExtensionsRoot, "alpha-space.ts"), "// alpha\n", "utf8");

    const { pi, ctx } = createMockHarness({
      cwd,
      hasUI: true,
      selectResult: "Exit without saving",
    });
    let afterSpace: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (component) => {
          component.handleInput?.(" ");
          afterSpace = component.render(120);
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(
      afterSpace.some((line) => line.includes("○ [P]") && line.includes("alpha-space.ts")),
      "expected Space to keep local toggling working"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
