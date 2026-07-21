import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getProfileStorePath, readProfileStore } from "../profiles/store.js";
import { packageSourceString } from "../utils/package-source.js";

export interface LocalCompletionIndex {
  installedPackages: string[];
  savedProfiles: string[];
}

let index: LocalCompletionIndex = { installedPackages: [], savedProfiles: [] };

export async function refreshLocalCompletionIndex(
  cwd: string,
  projectTrusted = false
): Promise<LocalCompletionIndex> {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const installedPackages = [
    ...(settings.getGlobalSettings().packages ?? []),
    ...(settings.getProjectSettings().packages ?? []),
  ].map(packageSourceString);
  const savedProfiles = Object.keys((await readProfileStore(getProfileStorePath())).profiles);
  index = {
    installedPackages: [...new Set(installedPackages)].sort(),
    savedProfiles: [...new Set(savedProfiles)].sort(),
  };
  return getLocalCompletionIndex();
}

export function getLocalCompletionIndex(): LocalCompletionIndex {
  return {
    installedPackages: [...index.installedPackages],
    savedProfiles: [...index.savedProfiles],
  };
}

export function setLocalCompletionIndexForTests(value?: Partial<LocalCompletionIndex>): void {
  index = {
    installedPackages: [...(value?.installedPackages ?? [])],
    savedProfiles: [...(value?.savedProfiles ?? [])],
  };
}
