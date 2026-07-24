import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showListReport, showReport } from "../src/ui/report.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";

initTheme();

function useReportCapture(
  ctx: ReturnType<typeof createMockHarness>["ctx"],
  onPanel: (component: { handleInput?(data: string): void }, lines: string[]) => void
): () => string[][] {
  const renders: string[][] = [];
  (ctx.ui as { custom: (factory: unknown, options?: unknown) => Promise<unknown> }).custom = (
    factory
  ) =>
    captureCustomComponent(factory, ctx.ui.theme, (component, lines, completion) => {
      renders.push(lines);
      onPanel(component, lines);
      return completion;
    });
  return () => renders;
}

void test("report content is shown in a panel and closes on Escape", async () => {
  const { ctx } = createMockHarness({ hasUI: true });
  const getRenders = useReportCapture(ctx, (component) => component.handleInput?.("\u001b"));

  await showReport(ctx, {
    title: "Demo report",
    lines: ["first line", "second line"],
  });

  const lines = getRenders()[0] ?? [];
  assert.ok(lines.some((line) => line.includes("Demo report")));
  assert.ok(lines.some((line) => line.includes("first line")));
  assert.ok(lines.some((line) => line.includes("second line")));
  assert.ok(lines.some((line) => line.includes("Esc close")));
});

void test("report panels always fit within the terminal height", async () => {
  const { ctx } = createMockHarness({ hasUI: true });
  const lines = Array.from({ length: 200 }, (_, index) => `row-${index}`);

  for (const height of [8, 12, 24, 50]) {
    let rendered: string[] = [];
    (ctx.ui as { custom: (factory: unknown, options?: unknown) => Promise<unknown> }).custom = (
      factory
    ) =>
      captureCustomComponent(
        factory,
        ctx.ui.theme,
        (component, out, completion) => {
          rendered = out;
          component.handleInput?.("\u001b");
          return completion;
        },
        { width: 80, height }
      );

    await showReport(ctx, { title: "Tall", lines });
    assert.ok(
      rendered.length <= height,
      `panel of ${rendered.length} rows overflows a ${height}-row terminal`
    );
    assert.ok(
      rendered[rendered.length - 1]?.includes("Esc close"),
      "expected the close hint to stay visible"
    );
  }
});

void test("report panels stay within the rendered width", async () => {
  const { ctx } = createMockHarness({ hasUI: true });
  const longLine = "x".repeat(500);
  let captured: string[] = [];
  (ctx.ui as { custom: (factory: unknown, options?: unknown) => Promise<unknown> }).custom = (
    factory
  ) =>
    captureCustomComponent(
      factory,
      ctx.ui.theme,
      (component, lines, completion) => {
        captured = lines;
        component.handleInput?.("\u001b");
        return completion;
      },
      { width: 60 }
    );

  await showReport(ctx, { title: "Wide", lines: [longLine] });

  assert.ok(captured.length > 0);
  for (const line of captured) {
    assert.ok(visibleWidth(line) <= 60, `line exceeds width: ${visibleWidth(line)}`);
  }
});

void test("long reports scroll instead of truncating content", async () => {
  const { ctx } = createMockHarness({ hasUI: true });
  const lines = Array.from({ length: 120 }, (_, index) => `entry-${index + 1}`);
  let first: string[] = [];
  let afterEnd: string[] = [];
  (ctx.ui as { custom: (factory: unknown, options?: unknown) => Promise<unknown> }).custom = (
    factory
  ) =>
    captureCustomComponent(
      factory,
      ctx.ui.theme,
      (component, rendered, completion) => {
        first = rendered;
        component.handleInput?.("\u001b[F"); // End key
        afterEnd = (component as { render(width: number): string[] }).render(80);
        component.handleInput?.("\u001b");
        return completion;
      },
      { width: 80, height: 24 }
    );

  await showReport(ctx, { title: "Long", lines });

  assert.ok(
    first.some((line) => line.includes("entry-1")),
    "expected the panel to start at the top"
  );
  assert.ok(
    !first.some((line) => line.includes("entry-120")),
    "expected the tail to be off-screen initially"
  );
  assert.ok(
    afterEnd.some((line) => line.includes("entry-120")),
    "expected End to jump to the last entry"
  );
});

void test("report placement selects side or center overlay anchoring", async () => {
  const { ctx } = createMockHarness({ hasUI: true });
  const capturedOptions: unknown[] = [];
  (ctx.ui as { custom: (factory: unknown, options?: unknown) => Promise<unknown> }).custom = (
    factory,
    options
  ) => {
    capturedOptions.push(options);
    return captureCustomComponent(factory, ctx.ui.theme, (component, _lines, completion) => {
      component.handleInput?.("\u001b");
      return completion;
    });
  };

  await showReport(ctx, { title: "Side", lines: ["x"] });
  await showReport(ctx, { title: "Center", lines: ["x"], placement: "center" });

  const [side, center] = capturedOptions as Array<{
    overlay?: boolean;
    overlayOptions?: { anchor?: string };
  }>;
  assert.equal(side?.overlay, true);
  assert.equal(side?.overlayOptions?.anchor, "top-right");
  assert.equal(center?.overlay, true);
  assert.equal(center?.overlayOptions?.anchor, "center");
});

void test("reports fall back to notifications without custom UI", async () => {
  const { ctx, notifications, customCallCount } = createMockHarness({
    hasUI: true,
    hasCustomUI: false,
  });

  await showReport(ctx, { title: "Fallback report", lines: ["alpha", "beta"] });

  assert.equal(customCallCount(), 0);
  assert.ok(
    notifications.some(
      (entry) =>
        entry.message.includes("Fallback report") &&
        entry.message.includes("alpha") &&
        entry.message.includes("beta")
    )
  );
});

void test("reports fall back to notifications when custom UI degrades", async () => {
  const { ctx, notifications } = createMockHarness({ hasUI: true });
  // Default harness custom() resolves undefined without rendering.

  await showReport(ctx, { title: "Degraded report", lines: ["gamma"] });

  assert.ok(
    notifications.some(
      (entry) => entry.message.includes("Degraded report") && entry.message.includes("gamma")
    )
  );
});

void test("empty list reports produce a short notification instead of a panel", async () => {
  const { ctx, notifications, customCallCount } = createMockHarness({ hasUI: true });

  await showListReport(ctx, "Trash", []);

  assert.equal(customCallCount(), 0);
  assert.ok(notifications.some((entry) => entry.message.toLowerCase().includes("no trash")));
});
