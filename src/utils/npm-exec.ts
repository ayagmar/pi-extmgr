import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execPath, platform } from "node:process";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

interface NpmCommandResolutionOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
  npmCommand?: readonly string[] | undefined;
  cwd?: string;
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

const settingsManagersByPath = new Map<string, SettingsManager>();
let warnedAboutBunGlobalDirHeuristic = false;

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
  const agentDir = getAgentDir();
  const cacheKey = `${agentDir}\0${cwd}`;
  const cached = settingsManagersByPath.get(cacheKey);
  if (cached) {
    return cached.getNpmCommand();
  }

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManagersByPath.set(cacheKey, settingsManager);
  return settingsManager.getNpmCommand();
}

function getCommandName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? "").replace(/\.(cmd|exe)$/i, "");
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

function resolveBunConfigPath(value: string, baseDir: string): string {
  const expanded = expandHome(value.trim());
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function stripTomlComment(line: string): string {
  return line.replace(/\s+#.*$/, "").trim();
}

function readBunGlobalDirFromBunfig(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }

  let inInstallSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      inInstallSection = sectionMatch[1]?.trim() === "install";
      continue;
    }

    const keyMatch = line.match(/^(install\.)?globalDir\s*=\s*(["'])(.*?)\2/);
    if (!keyMatch) continue;
    if (!inInstallSection && !keyMatch[1]) continue;

    const value = keyMatch[3]?.trim();
    return value ? resolveBunConfigPath(value, path.dirname(configPath)) : undefined;
  }

  return undefined;
}

function getBunGlobalDir(cwd?: string): string | undefined {
  const envGlobalDir = process.env.BUN_INSTALL_GLOBAL_DIR?.trim();
  if (envGlobalDir) {
    return resolveBunConfigPath(envGlobalDir, process.cwd());
  }

  const candidates = [
    path.join(homedir(), ".bunfig.toml"),
    ...(process.env.XDG_CONFIG_HOME
      ? [path.join(process.env.XDG_CONFIG_HOME, ".bunfig.toml")]
      : []),
    ...(cwd ? [path.join(cwd, "bunfig.toml")] : []),
  ];

  let globalDir: string | undefined;
  for (const configPath of candidates) {
    globalDir = readBunGlobalDirFromBunfig(configPath) ?? globalDir;
  }
  return globalDir;
}

function warnAboutBunGlobalDirHeuristic(): void {
  if (warnedAboutBunGlobalDirHeuristic) return;
  warnedAboutBunGlobalDirHeuristic = true;
  console.warn(
    "[extmgr] Could not read Bun globalDir from BUN_INSTALL_GLOBAL_DIR or bunfig.toml; " +
      "guessing from `bun pm bin -g`. If Bun's globalDir is customized, set BUN_INSTALL_GLOBAL_DIR."
  );
}

function getBunNodeModulesRoot(globalBinDir: string, cwd?: string): string {
  const globalDir = getBunGlobalDir(cwd);
  if (globalDir) {
    return path.join(globalDir, "node_modules");
  }

  // Best-effort fallback for Bun's default layout: globalBinDir is usually
  // ~/.bun/bin and globalDir is usually ~/.bun/install/global. This may be
  // wrong when [install].globalDir is customized in bunfig.toml.
  warnAboutBunGlobalDirHeuristic();
  return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
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

  if (configured && getCommandName(configured.command) === "bun") {
    return {
      command: configured.command,
      args: [...configured.args, "pm", "bin", "-g"],
      getRoot: (stdout) => {
        const binDir = stdout.trim();
        return binDir ? getBunNodeModulesRoot(binDir, options?.cwd) : "";
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
  return resolveNpmRootCommand({ npmCommand: getSettingsNpmCommand(cwd), cwd });
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
