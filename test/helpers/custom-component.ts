const noop = (): undefined => undefined;

export interface TestCustomComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}

export interface CaptureCustomComponentOptions {
  width?: number;
  height?: number;
  matcher?: (lines: string[]) => boolean;
  mismatchTimeoutMs?: number;
}

export function captureCustomComponent<T>(
  factory: unknown,
  theme: unknown,
  matcher: (lines: string[]) => boolean,
  onReady: (
    component: TestCustomComponent,
    lines: string[],
    completion: Promise<unknown>
  ) => T | Promise<T>
): Promise<T | unknown>;
export function captureCustomComponent<T>(
  factory: unknown,
  theme: unknown,
  onReady: (
    component: TestCustomComponent,
    lines: string[],
    completion: Promise<unknown>
  ) => T | Promise<T>,
  options?: CaptureCustomComponentOptions
): Promise<T | unknown>;
export async function captureCustomComponent<T>(
  factory: unknown,
  theme: unknown,
  matcherOrOnReady:
    | ((lines: string[]) => boolean)
    | ((
        component: TestCustomComponent,
        lines: string[],
        completion: Promise<unknown>
      ) => T | Promise<T>),
  onReadyOrOptions?:
    | ((
        component: TestCustomComponent,
        lines: string[],
        completion: Promise<unknown>
      ) => T | Promise<T>)
    | CaptureCustomComponentOptions,
  maybeOptions?: CaptureCustomComponentOptions
): Promise<T | unknown> {
  const matcher =
    typeof onReadyOrOptions === "function"
      ? (matcherOrOnReady as (lines: string[]) => boolean)
      : undefined;
  const onReady =
    typeof onReadyOrOptions === "function"
      ? onReadyOrOptions
      : (matcherOrOnReady as (
          component: TestCustomComponent,
          lines: string[],
          completion: Promise<unknown>
        ) => T | Promise<T>);
  const options = typeof onReadyOrOptions === "function" ? maybeOptions : onReadyOrOptions;

  let resolveCompletion: (value: unknown) => void = () => undefined;
  const completion = new Promise<unknown>((resolve) => {
    resolveCompletion = resolve;
  });

  const width = options?.width ?? 120;
  const height = options?.height ?? 40;
  const component = await (
    factory as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: unknown) => void
    ) => Promise<TestCustomComponent> | TestCustomComponent
  )(
    { requestRender: noop, terminal: { rows: height, columns: width } },
    theme,
    {},
    resolveCompletion
  );

  try {
    const lines = component.render(width);
    if ((matcher ?? options?.matcher) && !(matcher ?? options?.matcher)?.(lines)) {
      return await Promise.race([
        completion,
        new Promise<unknown>((resolve) =>
          setTimeout(() => resolve(undefined), options?.mismatchTimeoutMs ?? 50)
        ),
      ]);
    }

    return await onReady(component, lines, completion);
  } finally {
    component.dispose?.();
  }
}
