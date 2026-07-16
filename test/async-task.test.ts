import assert from "node:assert/strict";
import test from "node:test";
import { RequestGeneration, runTaskWithLoader } from "../src/ui/async-task.js";

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

void test("request generations abort obsolete work and reject stale commits", () => {
  const requests = new RequestGeneration();
  const first = requests.begin();
  const second = requests.begin();
  let committed = "";

  assert.equal(first.signal.aborted, true);
  assert.equal(
    first.commit(() => (committed = "stale")),
    false
  );
  assert.equal(
    second.commit(() => (committed = "current")),
    true
  );
  assert.equal(committed, "current");
});

void test("cancelled loaders block late status rendering", async () => {
  let releaseTask: () => void = () => undefined;
  const taskBlocked = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let renders = 0;

  const result = await runTaskWithLoader(
    {
      hasUI: true,
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            keys: unknown,
            done: (value: unknown) => void
          ) => { handleInput?(data: string): void; dispose?(): void }
        ) => {
          let complete: (value: unknown) => void = () => undefined;
          const completion = new Promise<unknown>((resolve) => {
            complete = resolve;
          });
          const component = factory(
            { requestRender: () => (renders += 1) },
            { fg: (_name: string, text: string) => text, bold: (text: string) => text },
            {},
            complete
          );
          component.handleInput?.("\u001b");
          const value = await completion;
          component.dispose?.();
          return value;
        },
      },
    } as never,
    { title: "Cancel", message: "Working..." },
    async ({ setMessage }) => {
      await taskBlocked;
      setMessage("late update");
      return "late";
    }
  );

  assert.equal(result, undefined);
  const rendersAtCancellation = renders;
  releaseTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renders, rendersAtCancellation);
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
