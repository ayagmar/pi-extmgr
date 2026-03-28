import assert from "node:assert/strict";
import test from "node:test";
import { runTaskWithLoader } from "../src/ui/async-task.js";

void test("runTaskWithLoader falls back to running the task when custom UI degrades", async () => {
  let runs = 0;

  const result = await runTaskWithLoader(
    {
      hasUI: true,
      ui: {
        custom: async () => undefined,
      },
    } as never,
    {
      title: "Test",
      message: "Running...",
      cancellable: false,
      fallbackWithoutLoader: true,
    },
    async () => {
      runs += 1;
      return "ok";
    }
  );

  assert.equal(result, "ok");
  assert.equal(runs, 1);
});

void test("runTaskWithLoader does not rerun the task when custom UI returned undefined after starting it", async () => {
  let runs = 0;

  const result = await runTaskWithLoader(
    {
      hasUI: true,
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (value: unknown) => void
          ) => unknown
        ) => {
          factory(
            { requestRender: () => undefined },
            { fg: (_name: string, text: string) => text, bold: (text: string) => text },
            {},
            () => undefined
          );
          return undefined;
        },
      },
    } as never,
    {
      title: "Test",
      message: "Running...",
      cancellable: false,
      fallbackWithoutLoader: true,
    },
    async () => {
      runs += 1;
      return "ok";
    }
  );

  assert.equal(result, "ok");
  assert.equal(runs, 1);
});

void test("runTaskWithLoader preserves undefined task results without treating them as cancellation", async () => {
  let runs = 0;

  const result = await runTaskWithLoader(
    {
      hasUI: false,
    } as never,
    {
      title: "Test",
      message: "Running...",
      cancellable: false,
    },
    async () => {
      runs += 1;
      return undefined;
    }
  );

  assert.equal(result, undefined);
  assert.equal(runs, 1);
});

void test("runTaskWithLoader surfaces synchronous task throws as rejections", async () => {
  await assert.rejects(
    () =>
      runTaskWithLoader(
        {
          hasUI: false,
        } as never,
        {
          title: "Test",
          message: "Running...",
          cancellable: false,
        },
        () => {
          throw new Error("boom");
        }
      ),
    /boom/
  );
});
