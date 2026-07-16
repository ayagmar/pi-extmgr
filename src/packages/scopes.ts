import { type InstalledPackage, type Scope } from "../types/index.js";
import { normalizePackageIdentity } from "../utils/package-source.js";

export interface PackageScopeComparison {
  identity: string;
  name: string;
  global?: InstalledPackage;
  project?: InstalledPackage;
  status: "global-only" | "project-only" | "overridden" | "same" | "different";
}

/** Compare effective package records across global and project scopes. */
export function comparePackageScopes(packages: InstalledPackage[]): PackageScopeComparison[] {
  const byIdentity = new Map<string, PackageScopeComparison>();

  for (const pkg of packages) {
    const identity = normalizePackageIdentity(pkg.source);
    const existing = byIdentity.get(identity) ?? {
      identity,
      name: pkg.name,
      status: "global-only" as const,
    };
    if (pkg.scope === "project") existing.project = pkg;
    else existing.global = pkg;
    byIdentity.set(identity, existing);
  }

  return [...byIdentity.values()]
    .map((entry) => {
      if (entry.global && entry.project) {
        const globalSource = normalizePackageIdentity(entry.global.source);
        const projectSource = normalizePackageIdentity(entry.project.source);
        return {
          ...entry,
          status: globalSource === projectSource ? ("overridden" as const) : ("different" as const),
        };
      }
      return {
        ...entry,
        status: entry.project ? ("project-only" as const) : ("global-only" as const),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPackageScopeLabel(scope: Scope): string {
  return scope === "project" ? "project (.pi/settings.json)" : "global (~/.pi/agent/settings.json)";
}
