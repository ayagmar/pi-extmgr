import path from "node:path";
import { execPath, platform } from "node:process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface NpmCommandResolutionOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
}

interface NpmExecOptions {
  timeout: number;
}

function getNpmCliPath(nodeExecPath: string, runtimePlatform: NodeJS.Platform): string {
  const pathImpl = runtimePlatform === "win32" ? path.win32 : path;
  return pathImpl.join(pathImpl.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js");
}

export function resolveNpmCommand(
  npmArgs: string[],
  options?: NpmCommandResolutionOptions
): { command: string; args: string[] } {
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
  const resolved = resolveNpmCommand(npmArgs);
  return pi.exec(resolved.command, resolved.args, {
    timeout: options.timeout,
    cwd: ctx.cwd,
  });
}
