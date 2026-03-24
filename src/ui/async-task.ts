import type {
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { hasCustomUI } from "../utils/mode.js";

type AnyContext = ExtensionCommandContext | ExtensionContext;

const TASK_ABORTED = Symbol("task-aborted");
const TASK_FAILED = Symbol("task-failed");

export interface TaskControls {
  signal: AbortSignal;
  setMessage: (message: string) => void;
}

interface LoaderConfig {
  title: string;
  message: string;
  cancellable?: boolean;
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

export async function runTaskWithLoader<T>(
  ctx: AnyContext,
  config: LoaderConfig,
  task: (controls: TaskControls) => Promise<T>
): Promise<T | undefined> {
  if (!hasCustomUI(ctx)) {
    return task({
      signal: new AbortController().signal,
      setMessage: () => undefined,
    });
  }

  let taskError: unknown;

  const result = await ctx.ui.custom<T | typeof TASK_ABORTED | typeof TASK_FAILED>(
    (tui, theme, _keybindings, done) => {
      let finished = false;
      const finish = (value: T | typeof TASK_ABORTED | typeof TASK_FAILED): void => {
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

      void task({
        signal,
        setMessage: (message) => {
          loader.setMessage(message);
          tui.requestRender();
        },
      })
        .then((value) => finish(value))
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
    }
  );

  if (result === TASK_ABORTED) {
    return undefined;
  }

  if (result === TASK_FAILED) {
    throw taskError;
  }

  return result;
}
