import path from "node:path";
import { execPath, platform } from "node:process";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";

interface NpmCommandResolutionOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
  npmCommand?: readonly string[] | undefined;
}

interface ResolvedNpmCommand {
  command: string;
  args: string[];
}

interface ResolvedNpmRootCommand extends ResolvedNpmCommand {
  getRoot(stdout: string): string;
}

interface NpmExecOptions {
  timeout: number;
  signal?: AbortSignal;
}

function getNpmCliPath(nodeExecPath: string, runtimePlatform: NodeJS.Platform): string {
  const pathImpl = runtimePlatform === "win32" ? path.win32 : path;
  return pathImpl.join(pathImpl.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js");
}

function getConfiguredNpmBase(
  npmCommand?: readonly string[] | undefined
): ResolvedNpmCommand | undefined {
  if (!npmCommand || npmCommand.length === 0) {
    return undefined;
  }

  const [command, ...args] = npmCommand;
  if (!command?.trim()) {
    throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
  }

  return { command, args: [...args] };
}

function getSettingsNpmCommand(cwd: string): string[] | undefined {
  return SettingsManager.create(cwd, getAgentDir()).getNpmCommand();
}

export function resolveNpmCommand(
  npmArgs: string[],
  options?: NpmCommandResolutionOptions
): ResolvedNpmCommand {
  const configured = getConfiguredNpmBase(options?.npmCommand);
  if (configured) {
    return {
      command: configured.command,
      args: [...configured.args, ...npmArgs],
    };
  }

  const runtimePlatform = options?.platform ?? platform;

  if (runtimePlatform === "win32") {
    const nodeBinary = options?.nodeExecPath ?? execPath;
    return {
      command: nodeBinary,
      args: [getNpmCliPath(nodeBinary, runtimePlatform), ...npmArgs],
    };
  }

  return { command: "npm", args: npmArgs };
}

export function resolveConfiguredNpmCommand(npmArgs: string[], cwd: string): ResolvedNpmCommand {
  return resolveNpmCommand(npmArgs, { npmCommand: getSettingsNpmCommand(cwd) });
}

export function resolveNpmRootCommand(
  options?: NpmCommandResolutionOptions
): ResolvedNpmRootCommand {
  const configured = getConfiguredNpmBase(options?.npmCommand);

  if (configured?.command === "bun") {
    return {
      command: configured.command,
      args: [...configured.args, "pm", "bin", "-g"],
      getRoot: (stdout) => {
        const binDir = stdout.trim();
        return binDir ? path.join(path.dirname(binDir), "install", "global", "node_modules") : "";
      },
    };
  }

  const resolved = resolveNpmCommand(["root", "-g"], options);
  return {
    ...resolved,
    getRoot: (stdout) => stdout.trim(),
  };
}

export function resolveConfiguredNpmRootCommand(cwd: string): ResolvedNpmRootCommand {
  return resolveNpmRootCommand({ npmCommand: getSettingsNpmCommand(cwd) });
}

export async function execNpm(
  pi: ExtensionAPI,
  npmArgs: string[],
  ctx: { cwd: string },
  options: NpmExecOptions
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  const resolved = resolveConfiguredNpmCommand(npmArgs, ctx.cwd);
  return pi.exec(resolved.command, resolved.args, {
    timeout: options.timeout,
    cwd: ctx.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
