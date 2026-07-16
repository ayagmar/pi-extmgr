import { type InstalledPackage } from "../types/index.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { type AvailablePackageUpdate } from "./catalog.js";

export interface PackageUpdatePreview {
  source: string;
  name: string;
  scope: "global" | "project";
  currentVersion?: string;
  updateAvailable: boolean;
  metadataKnown: boolean;
}

export function buildUpdatePreview(
  installed: InstalledPackage[],
  available: AvailablePackageUpdate[]
): PackageUpdatePreview[] {
  const availableSources = new Set(available.map((item) => normalizePackageIdentity(item.source)));
  return installed.map((pkg) => ({
    source: pkg.source,
    name: pkg.name,
    scope: pkg.scope,
    ...(pkg.version ? { currentVersion: pkg.version } : {}),
    updateAvailable: availableSources.has(normalizePackageIdentity(pkg.source)),
    metadataKnown: Boolean(pkg.version),
  }));
}
