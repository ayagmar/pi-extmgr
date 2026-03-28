import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { configurePackageExtensions } from "../src/ui/package-config.js";
import { showInteractive } from "../src/ui/unified.js";
import { createMockHarness } from "./helpers/mocks.js";

initTheme();

const noop = (): undefined => undefined;

async function captureCustomComponent(
  factory: unknown,
  ctxTheme: Theme,
  matcher: (lines: string[]) => boolean,
  onMatch: (
    component: {
      render(width: number): string[];
      handleInput?(data: string): void;
      dispose?(): void;
    },
    lines: string[]
  ) => unknown
): Promise<unknown> {
  let resolveCompletion: (value: unknown) => void = () => undefined;
  const completion = new Promise<unknown>((resolve) => {
    resolveCompletion = resolve;
  });

  const component = await (
    factory as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: unknown) => void
    ) =>
      | Promise<{
          render(width: number): string[];
          handleInput?(data: string): void;
          dispose?(): void;
        }>
      | {
          render(width: number): string[];
          handleInput?(data: string): void;
          dispose?(): void;
        }
  )({ requestRender: noop, terminal: { rows: 40, columns: 120 } }, ctxTheme, {}, resolveCompletion);

  try {
    const lines = component.render(120);
    if (!matcher(lines)) {
      return await Promise.race([
        completion,
        new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 50)),
      ]);
    }

    return await onMatch(component, lines);
  } finally {
    component.dispose?.();
  }
}

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
        (lines) => lines.some((line) => line.includes("Space/Enter toggle local")),
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
