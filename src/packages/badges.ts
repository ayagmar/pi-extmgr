import { type NpmPackage } from "../types/index.js";

export interface PackageBadges {
  installed: boolean;
  updateAvailable: boolean;
  compatibility: "compatible" | "incompatible" | "unknown";
}

export function getRemotePackageBadges(
  pkg: NpmPackage,
  installedNames: Set<string>,
  updates: Set<string>
): PackageBadges {
  return {
    installed: installedNames.has(pkg.name),
    updateAvailable: updates.has(pkg.name),
    // Registry search metadata does not provide trustworthy Pi/Node requirements.
    compatibility: "unknown",
  };
}
