import { getAgentDir, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { getProfileStorePath, readProfileStore } from "../profiles/store.js";

export interface LocalCompletionIndex {
  installedPackages: string[];
  savedProfiles: string[];
}

let index: LocalCompletionIndex = { installedPackages: [], savedProfiles: [] };

function sourceOf(source: PackageSource): string {
  return typeof source === "string" ? source : source.source;
}

export async function refreshLocalCompletionIndex(
  cwd: string,
  projectTrusted = false
): Promise<LocalCompletionIndex> {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const installedPackages = [
    ...(settings.getGlobalSettings().packages ?? []),
    ...(settings.getProjectSettings().packages ?? []),
  ].map(sourceOf);
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
