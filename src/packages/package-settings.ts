/** Lookups over the package entries of one settings scope. */
import { type PackageSource, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Scope } from "../types/index.js";
import { normalizePackageIdentity, packageSourceString } from "../utils/package-source.js";
import { getAgentDir, getProjectConfigDir } from "../utils/pi-paths.js";

/** Settings key holding the configuration saved by a whole-package disable. */
export const DISABLED_SNAPSHOT_KEY = "piExtmgrDisabled";

export function isDisabledPackageEntry(entry: PackageSource): boolean {
  return typeof entry === "object" && Object.hasOwn(entry, DISABLED_SNAPSHOT_KEY);
}

export function getScopedPackages(settings: SettingsManager, scope: Scope): PackageSource[] {
  // getPackages() returns the merged view, where trusted project packages
  // replace the global list; writing that back would leak them into global.
  const packages =
    scope === "project"
      ? settings.getProjectSettings().packages
      : settings.getGlobalSettings().packages;
  return packages ? [...packages] : [];
}

/** Exact spelling wins; otherwise match identity relative to the selected settings scope. */
export function findConfiguredPackageIndex(
  packages: PackageSource[],
  source: string,
  scope: Scope,
  cwd: string
): number {
  const exact = packages.flatMap((entry, index) =>
    packageSourceString(entry) === source ? [index] : []
  );
  const base = scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  const identity = normalizePackageIdentity(source, { cwd: base });
  const matches = exact.length
    ? exact
    : packages.flatMap((entry, index) =>
        normalizePackageIdentity(packageSourceString(entry), { cwd: base }) === identity
          ? [index]
          : []
      );
  if (matches.length > 1) {
    throw new Error("Ambiguous package configuration in this scope.");
  }
  return matches[0] ?? -1;
}
