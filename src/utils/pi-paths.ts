import { homedir } from "node:os";
import { join, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Resolve Pi-owned and extmgr-owned paths at call time so test overrides apply. */
export function getProjectConfigDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME);
}

export function getProjectConfigPath(cwd: string, fileName: string): string {
  return join(getProjectConfigDir(cwd), fileName);
}

export function getExtmgrCacheDir(): string {
  return process.env.PI_EXTMGR_CACHE_DIR || join(getAgentDir(), ".extmgr-cache");
}

export function getExtmgrTrashDir(): string {
  return join(getAgentDir(), ".extmgr-trash");
}

export function getGlobalExtensionsDir(): string {
  return join(getAgentDir(), "extensions");
}

export function getProjectExtensionsDir(cwd: string): string {
  return join(getProjectConfigDir(cwd), "extensions");
}

/** Abbreviate the home directory to `~` for display. */
export function displayHomePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Labels honor PI_CODING_AGENT_DIR and a rebranded config dir. */
export function getGlobalSettingsLabel(): string {
  return displayHomePath(join(getAgentDir(), "settings.json"));
}

export function getProjectSettingsLabel(): string {
  return `${CONFIG_DIR_NAME}/settings.json`;
}

export { CONFIG_DIR_NAME, getAgentDir };
