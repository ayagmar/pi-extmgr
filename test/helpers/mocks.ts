import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface ExecCall {
  command: string;
  args: string[];
}

export type ExecImpl = (command: string, args: string[]) => ExecResult | Promise<ExecResult>;

export interface NotificationRecord {
  message: string;
  level: string | undefined;
}

export interface MockHarnessOptions {
  cwd?: string;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  hasCustomUI?: boolean;
  execImpl?: ExecImpl;
  inputResult?: string;
  selectResult?: string;
  confirmResult?: boolean;
  confirmImpl?: (title: string, message?: string) => boolean | Promise<boolean>;
  projectTrusted?: boolean;
  /**
   * Mirror pi >= 1.0: once `ctx.reload()` resolves, every access to the old
   * context throws, so tests catch code that keeps using it.
   */
  staleAfterReload?: boolean;
}

export const STALE_CONTEXT_MESSAGE =
  "This extension ctx is stale after session replacement or reload.";

function getDefaultTestCwd(): string {
  const cwd = process.env.PI_EXTMGR_TEST_CWD;
  if (!cwd) {
    throw new Error(
      "Test harness requires PI_EXTMGR_TEST_CWD; run tests through the package test script."
    );
  }
  return cwd;
}

export function createMockHarness(options: MockHarnessOptions = {}): {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  calls: ExecCall[];
  entries: { type: "custom"; customType: string; data: unknown }[];
  installedPackages: string[];
  notifications: NotificationRecord[];
  inputPrompts: string[];
  selectPrompts: string[];
  confirmPrompts: string[];
  customCallCount: () => number;
  reloadCount: () => number;
  statuses: Map<string, string | undefined>;
  widgets: Map<string, string[] | undefined>;
  titles: string[];
} {
  const calls: ExecCall[] = [];
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const installedPackages: string[] = [];
  const notifications: NotificationRecord[] = [];
  const inputPrompts: string[] = [];
  const selectPrompts: string[] = [];
  const confirmPrompts: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const titles: string[] = [];
  let customCalls = 0;
  let reloadCalls = 0;

  const installedRecords: { source: string; scope: "global" | "project" }[] = [];
  const customExecImpl = options.execImpl;

  const defaultExecImpl = (command: string, args: string[]): ExecResult => {
    // Track pi install/remove calls and simulate pi list
    if (command === "pi") {
      const subcommand = args[0];
      const source = args[args.length - 1];
      const scope: "global" | "project" = args.includes("-l") ? "project" : "global";

      if (subcommand === "install" && source) {
        installedRecords.push({ source, scope });
        installedPackages.push(source);
        return { code: 0, stdout: `Installed ${source}`, stderr: "", killed: false };
      }

      if (subcommand === "remove" && source) {
        const recordIndex = installedRecords.findIndex(
          (record) => record.source === source && record.scope === scope
        );
        if (recordIndex > -1) {
          installedRecords.splice(recordIndex, 1);
        } else {
          const fallbackIndex = installedRecords.findIndex((record) => record.source === source);
          if (fallbackIndex > -1) {
            installedRecords.splice(fallbackIndex, 1);
          }
        }

        const sourceIndex = installedPackages.indexOf(source);
        if (sourceIndex > -1) {
          installedPackages.splice(sourceIndex, 1);
        }

        return { code: 0, stdout: `Removed ${source}`, stderr: "", killed: false };
      }

      if (subcommand === "list") {
        if (installedRecords.length === 0) {
          return { code: 0, stdout: "No packages installed", stderr: "", killed: false };
        }

        const global = installedRecords.filter((record) => record.scope === "global");
        const project = installedRecords.filter((record) => record.scope === "project");

        const lines: string[] = [];
        if (global.length > 0) {
          lines.push("Global:");
          lines.push(...global.map((record) => `  ${record.source}`));
        }
        if (project.length > 0) {
          lines.push("Project:");
          lines.push(...project.map((record) => `  ${record.source}`));
        }

        return { code: 0, stdout: lines.join("\n"), stderr: "", killed: false };
      }
    }
    throw new Error(`Unexpected command from test: ${[command, ...args].join(" ")}`);
  };

  const execImpl = (command: string, args: string[]): ExecResult | Promise<ExecResult> => {
    if (customExecImpl) {
      return customExecImpl(command, args);
    }
    return defaultExecImpl(command, args);
  };

  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ui = {
    notify: (message: string, level?: string) => {
      notifications.push({ message, level });
    },
    select: (title: string) => {
      selectPrompts.push(title);
      return Promise.resolve(options.selectResult);
    },
    confirm: (title: string, message?: string) => {
      confirmPrompts.push(title);
      if (options.confirmImpl) {
        return Promise.resolve(options.confirmImpl(title, message));
      }
      return Promise.resolve(options.confirmResult ?? false);
    },
    input: (title: string) => {
      inputPrompts.push(title);
      return Promise.resolve(options.inputResult);
    },
    setStatus: (key: string, value: string | undefined) => {
      statuses.set(key, value);
    },
    setWidget: (key: string, content: string[] | undefined) => {
      widgets.set(key, content);
    },
    setTitle: (title: string) => {
      titles.push(title);
    },
    theme,
    custom:
      options.hasUI && options.hasCustomUI !== false
        ? (_factory: unknown) => {
            customCalls += 1;
            return Promise.resolve(undefined);
          }
        : undefined,
  };

  const pi = {
    exec: (command: string, args: string[]) => {
      calls.push({ command, args });
      return Promise.resolve(execImpl(command, args));
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  let stale = false;
  const rawCtx = {
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? (options.hasUI ? "tui" : "print"),
    cwd: options.cwd ?? getDefaultTestCwd(),
    isProjectTrusted: () => options.projectTrusted ?? true,
    ui,
    reload: () => {
      reloadCalls += 1;
      if (options.staleAfterReload) stale = true;
      return Promise.resolve();
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionName: () => undefined,
    },
  };
  const ctx = (options.staleAfterReload
    ? new Proxy(rawCtx, {
        get(target, property, receiver) {
          if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
          return Reflect.get(target, property, receiver);
        },
      })
    : rawCtx) as unknown as ExtensionCommandContext;

  return {
    pi,
    ctx,
    calls,
    entries,
    installedPackages,
    notifications,
    inputPrompts,
    selectPrompts,
    confirmPrompts,
    customCallCount: () => customCalls,
    reloadCount: () => reloadCalls,
    statuses,
    widgets,
    titles,
  };
}
