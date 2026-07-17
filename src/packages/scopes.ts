import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "../utils/pi-paths.js";
import { type InstalledPackage, type Scope } from "../types/index.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";

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
    const identity = normalizePackageIdentity(pkg.source, {
      ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
    });
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
        const globalSource = normalizePackageIdentity(entry.global.source, {
          ...(entry.global.resolvedPath ? { resolvedPath: entry.global.resolvedPath } : {}),
        });
        const projectSource = normalizePackageIdentity(entry.project.source, {
          ...(entry.project.resolvedPath ? { resolvedPath: entry.project.resolvedPath } : {}),
        });
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
  return scope === "project"
    ? `project (${CONFIG_DIR_NAME}/settings.json)`
    : "global (~/.pi/agent/settings.json)";
}

function sourceOf(value: PackageSource): string {
  return typeof value === "string" ? value : value.source;
}

function packageMatches(value: PackageSource, source: string, cwd: string, scope: Scope): boolean {
  const baseCwd = scope === "project" ? cwd : getAgentDir();
  return (
    sourceOf(value) === source ||
    normalizePackageIdentity(source, { cwd: baseCwd }) ===
      normalizePackageIdentity(sourceOf(value), { cwd: baseCwd })
  );
}

export interface MovePackageScopeResult {
  source: string;
  from: Scope;
  to: Scope;
  moved: boolean;
  partial?: boolean;
  conflict?: string;
}

/**
 * Promote a configured package between scopes while retaining the complete
 * settings object (including filters and unknown package fields).
 *
 * The destination is written before the source is removed. If the second
 * write fails, the package remains effective rather than disappearing.
 */
export async function movePackageBetweenScopes(
  source: string,
  from: Scope,
  to: Scope,
  cwd: string,
  projectTrusted = false
): Promise<MovePackageScopeResult> {
  if (from === to) {
    return { source, from, to, moved: false, conflict: "Package is already in that scope." };
  }

  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  try {
    throwIfSettingsErrors(settings, "Package scope move");
  } catch (error) {
    return {
      source,
      from,
      to,
      moved: false,
      conflict: error instanceof Error ? error.message : String(error),
    };
  }
  const globalPackages = [...(settings.getGlobalSettings().packages ?? [])];
  const projectPackages = [...(settings.getProjectSettings().packages ?? [])];
  const sourcePackages = from === "global" ? globalPackages : projectPackages;
  const destinationPackages = to === "global" ? globalPackages : projectPackages;
  const sourceIndex = sourcePackages.findIndex((entry) => packageMatches(entry, source, cwd, from));

  if (sourceIndex < 0) {
    return { source, from, to, moved: false, conflict: "Package is not configured in that scope." };
  }

  const entry = sourcePackages[sourceIndex];
  if (!entry) {
    return { source, from, to, moved: false, conflict: "Package is not configured in that scope." };
  }
  const destinationIndex = destinationPackages.findIndex((candidate) =>
    packageMatches(candidate, sourceOf(entry), cwd, to)
  );
  if (destinationIndex >= 0) {
    const destinationEntry = destinationPackages[destinationIndex];
    if (destinationEntry && JSON.stringify(destinationEntry) !== JSON.stringify(entry)) {
      return {
        source,
        from,
        to,
        moved: false,
        conflict: "The destination has a different package configuration; no changes were made.",
      };
    }
  } else {
    destinationPackages.push(structuredClone(entry));
  }

  try {
    if (to === "global") settings.setPackages(destinationPackages);
    else settings.setProjectPackages(destinationPackages);
    await settings.flush();
    throwIfSettingsErrors(settings, "Package scope move");
  } catch (error) {
    return {
      source,
      from,
      to,
      moved: false,
      conflict: error instanceof Error ? error.message : String(error),
    };
  }

  sourcePackages.splice(sourceIndex, 1);
  try {
    if (from === "global") settings.setPackages(sourcePackages);
    else settings.setProjectPackages(sourcePackages);
    await settings.flush();
    throwIfSettingsErrors(settings, "Package scope move");
  } catch (error) {
    return {
      source: sourceOf(entry),
      from,
      to,
      moved: false,
      partial: true,
      conflict: `The package was copied to ${to}, but could not be removed from ${from}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { source: sourceOf(entry), from, to, moved: true };
}
