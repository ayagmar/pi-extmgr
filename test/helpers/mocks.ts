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

export interface MockHarnessOptions {
  cwd?: string;
  hasUI?: boolean;
  execImpl?: ExecImpl;
}

const OK: ExecResult = { code: 0, stdout: "ok", stderr: "", killed: false };

export function createMockHarness(options: MockHarnessOptions = {}): {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  calls: ExecCall[];
  entries: { type: "custom"; customType: string; data: unknown }[];
  installedPackages: string[];
} {
  const calls: ExecCall[] = [];
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const installedPackages: string[] = [];
  const customExecImpl = options.execImpl;

  const defaultExecImpl = (command: string, args: string[]): ExecResult => {
    // Track pi install/remove calls and simulate pi list
    if (command === "pi") {
      const subcommand = args[0];
      const source = args[args.length - 1];

      if (subcommand === "install" && source) {
        installedPackages.push(source);
        return { code: 0, stdout: `Installed ${source}`, stderr: "", killed: false };
      }

      if (subcommand === "remove" && source) {
        const index = installedPackages.indexOf(source);
        if (index > -1) {
          installedPackages.splice(index, 1);
        }
        return { code: 0, stdout: `Removed ${source}`, stderr: "", killed: false };
      }

      if (subcommand === "list") {
        if (installedPackages.length === 0) {
          return { code: 0, stdout: "No packages installed", stderr: "", killed: false };
        }
        const output = installedPackages.map((p) => `npm:${p}`).join("\n");
        return { code: 0, stdout: output, stderr: "", killed: false };
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
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

  return { pi, ctx, calls, entries, installedPackages };
}
