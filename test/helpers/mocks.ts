import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

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
  hasCustomUI?: boolean;
  execImpl?: ExecImpl;
  inputResult?: string;
  selectResult?: string;
  confirmResult?: boolean;
  confirmImpl?: (title: string, message?: string) => boolean | Promise<boolean>;
}

const OK: ExecResult = { code: 0, stdout: "ok", stderr: "", killed: false };

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
} {
  const calls: ExecCall[] = [];
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const installedPackages: string[] = [];
  const notifications: NotificationRecord[] = [];
  const inputPrompts: string[] = [];
  const selectPrompts: string[] = [];
  const confirmPrompts: string[] = [];
  let customCalls = 0;

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
    return OK;
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

  const ctx = {
    hasUI: options.hasUI ?? false,
    cwd: options.cwd ?? "/tmp",
    ui,
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

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
  };
}
