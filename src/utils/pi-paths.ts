import { CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

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

export function getPackageStorageDir(): string {
  return getPackageDir();
}

export { CONFIG_DIR_NAME, getAgentDir };
