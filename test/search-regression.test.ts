import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { configurePackageExtensions } from "../src/ui/package-config.js";
import { showInteractive } from "../src/ui/unified.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

async function createPackageWithExtensions(root: string, count: number): Promise<void> {
  await mkdir(join(root, "extensions"), { recursive: true });

  const extensions = Array.from({ length: count }, (_, index) => `./extensions/ext-${index}.ts`);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", pi: { extensions } }, null, 2),
    "utf8"
  );

  for (let index = 0; index < count; index += 1) {
    await writeFile(join(root, "extensions", `ext-${index}.ts`), `// ext ${index}\n`, "utf8");
  }
}

void test("package extension config does not start filtering on plain typing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-search-config-"));
  const pkgRoot = join(cwd, "vendor", "demo");

  try {
    await createPackageWithExtensions(pkgRoot, 9);

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let beforeTyping: string[] = [];
    let afterTyping: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("Configure extensions: demo")),
        (component, lines) => {
          beforeTyping = lines;
          component.handleInput?.("z");
          afterTyping = component.render(120);
          return { type: "cancel" };
        }
      );

    const result = await configurePackageExtensions(
      {
        source: "./vendor/demo",
        name: "demo",
        scope: "project",
        resolvedPath: pkgRoot,
      },
      ctx,
      pi
    );

    assert.deepEqual(result, { changed: 0, reloaded: false });
    assert.ok(beforeTyping.some((line) => line.includes("ext-0.ts")));
    assert.ok(afterTyping.some((line) => line.includes("ext-0.ts")));
    assert.ok(!afterTyping.some((line) => line.includes("No matching settings")));
    assert.ok(!afterTyping.some((line) => line.includes("Type to search")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions manager does not start filtering on plain typing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-search-unified-"));
  const projectExtensionsRoot = join(cwd, ".pi", "extensions");

  try {
    await mkdir(projectExtensionsRoot, { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      await writeFile(
        join(projectExtensionsRoot, `alpha-${index}.ts`),
        `// alpha ${index}\n`,
        "utf8"
      );
    }

    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let beforeTyping: string[] = [];
    let afterTyping: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (component, lines) => {
          beforeTyping = lines;
          component.handleInput?.("z");
          afterTyping = component.render(120);
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(beforeTyping.some((line) => line.includes("alpha-0.ts")));
    assert.ok(afterTyping.some((line) => line.includes("alpha-0.ts")));
    assert.ok(!afterTyping.some((line) => line.includes("No matching settings")));
    assert.ok(!afterTyping.some((line) => line.includes("Type to search")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("/extensions manager slash search hides unrelated fuzzy description matches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-search-slash-"));
  const restoreCatalog = mockPackageCatalog({
    packages: [
      {
        source: "npm:pi-anycopy",
        name: "pi-anycopy",
        version: "0.2.3",
        description: "Copy any tree node to the clipboard.",
        scope: "global",
      },
      {
        source: "npm:pi-bash-live-view",
        name: "pi-bash-live-view",
        version: "0.1.1",
        description:
          "A pi extension that adds optional PTY-backed live terminal rendering to the bash tool via usePTY=true.",
        scope: "global",
      },
    ],
  });

  try {
    const { pi, ctx } = createMockHarness({ cwd, hasUI: true });
    let afterSearch: string[] = [];

    (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (lines) => lines.some((line) => line.includes("i install")),
        (component) => {
          component.handleInput?.("/");
          for (const char of "anycopy") {
            component.handleInput?.(char);
          }
          afterSearch = component.render(120);
          return { type: "cancel" };
        }
      );

    await showInteractive(ctx, pi);

    assert.ok(afterSearch.some((line) => line.includes("anycopy")));
    assert.ok(!afterSearch.some((line) => line.includes("pi-bash-live-view")));
    assert.ok(afterSearch.some((line) => line.includes("showing 1 of")));
  } finally {
    restoreCatalog();
    await rm(cwd, { recursive: true, force: true });
  }
});
