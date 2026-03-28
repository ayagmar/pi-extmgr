import {
  DynamicBorder,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { hasCustomUI } from "../utils/mode.js";

type AnyContext = ExtensionCommandContext | ExtensionContext;

const TASK_ABORTED = Symbol("task-aborted");
const TASK_FAILED = Symbol("task-failed");

type TaskSuccess<T> = { type: "ok"; value: T };

export interface TaskControls {
  signal: AbortSignal;
  setMessage: (message: string) => void;
}

interface LoaderConfig {
  title: string;
  message: string;
  cancellable?: boolean;
  fallbackWithoutLoader?: boolean;
}

function createLoaderComponent(
  tui: TUI,
  theme: Theme,
  title: string,
  message: string,
  cancellable: boolean,
  onCancel: () => void
): {
  container: Container;
  loader: Loader | CancellableLoader;
  signal: AbortSignal;
} {
  const container = new Container();
  const borderColor = (text: string) => theme.fg("accent", text);
  const loader = cancellable
    ? new CancellableLoader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        message
      )
    : new Loader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        message
      );

  container.addChild(new DynamicBorder(borderColor));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  container.addChild(loader);

  if (cancellable) {
    (loader as CancellableLoader).onAbort = onCancel;
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "Esc cancel"), 1, 0));
  }

  container.addChild(new Spacer(1));
  container.addChild(new DynamicBorder(borderColor));

  const signal = cancellable ? (loader as CancellableLoader).signal : new AbortController().signal;

  return { container, loader, signal };
}

function runTaskWithoutLoader<T>(task: (controls: TaskControls) => Promise<T>): Promise<T> {
  return Promise.resolve().then(() =>
    task({
      signal: new AbortController().signal,
      setMessage: () => undefined,
    })
  );
}

export async function runTaskWithLoader<T>(
  ctx: AnyContext,
  config: LoaderConfig,
  task: (controls: TaskControls) => Promise<T>
): Promise<T | undefined> {
  if (!hasCustomUI(ctx)) {
    return runTaskWithoutLoader(task);
  }

  let taskError: unknown;
  let startedTask: Promise<T> | undefined;
  let cleanupStartedTaskUI: (() => void) | undefined;

  const result = await ctx.ui.custom<
    TaskSuccess<T> | typeof TASK_ABORTED | typeof TASK_FAILED | undefined
  >((tui, theme, _keybindings, done) => {
    let finished = false;
    const finish = (
      value: TaskSuccess<T> | typeof TASK_ABORTED | typeof TASK_FAILED | undefined
    ): void => {
      if (finished) {
        return;
      }
      finished = true;
      done(value);
    };

    const { container, loader, signal } = createLoaderComponent(
      tui,
      theme,
      config.title,
      config.message,
      config.cancellable ?? true,
      () => finish(TASK_ABORTED)
    );

    cleanupStartedTaskUI = () => {
      if (loader instanceof CancellableLoader) {
        loader.dispose();
        return;
      }

      loader.stop();
    };

    startedTask = Promise.resolve().then(() =>
      task({
        signal,
        setMessage: (message) => {
          loader.setMessage(message);
          tui.requestRender();
        },
      })
    );

    void startedTask
      .then((value) => finish({ type: "ok", value }))
      .catch((error) => {
        if (signal.aborted) {
          finish(TASK_ABORTED);
          return;
        }

        taskError = error;
        finish(TASK_FAILED);
      });

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (loader instanceof CancellableLoader) {
          loader.handleInput(data);
          tui.requestRender();
        }
      },
      dispose() {
        if (loader instanceof CancellableLoader) {
          loader.dispose();
          return;
        }

        loader.stop();
      },
    };
  });

  if (result === undefined) {
    if (startedTask) {
      return startedTask.finally(() => cleanupStartedTaskUI?.());
    }
    if (config.fallbackWithoutLoader) {
      return runTaskWithoutLoader(task);
    }
    return undefined;
  }

  if (result === TASK_ABORTED) {
    return undefined;
  }

  if (result === TASK_FAILED) {
    throw taskError;
  }

  return result.value;
}
