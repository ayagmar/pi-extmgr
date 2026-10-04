import path from "node:path";
import { execPath, platform } from "node:process";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

interface NpmCommandResolutionOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
  npmCommand?: readonly string[] | undefined;
}

interface ResolvedNpmCommand {
  command: string;
  args: string[];
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

/**
 * Global `npmCommand` for code paths without the extension API. Read fresh so
 * edits to settings.json apply without restarting pi.
 */
function getSettingsNpmCommand(cwd: string): string[] | undefined {
  return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getNpmCommand();
}

/**
 * pi's effective settings (global merged with a trusted project's), so npm
 * metadata calls use the same `npmCommand` as pi's own package manager.
 */
function getEffectiveNpmCommand(pi: ExtensionAPI, cwd: string): string[] | undefined {
  if (typeof pi.getSettings === "function") {
    const npmCommand = pi.getSettings().npmCommand;
    return npmCommand ? [...npmCommand] : undefined;
  }
  return getSettingsNpmCommand(cwd);
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

export async function execNpm(
  pi: ExtensionAPI,
  npmArgs: string[],
  ctx: { cwd: string },
  options: NpmExecOptions
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  const resolved = resolveNpmCommand(npmArgs, { npmCommand: getEffectiveNpmCommand(pi, ctx.cwd) });
  return pi.exec(resolved.command, resolved.args, {
    timeout: options.timeout,
    cwd: ctx.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
