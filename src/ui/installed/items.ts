/** Pure helpers that build and interrogate the unified Installed item list. */
import { type discoverExtensions } from "../../extensions/discovery.js";
import {
  type InstalledPackage,
  type LocalUnifiedItem,
  type PackageExtensionEntry,
  type PackageExtensionStateSummary,
  type State,
  type UnifiedItem,
} from "../../types/index.js";
import { normalizePackageIdentity } from "../../utils/package-source.js";
import { normalizePathIdentity } from "../../utils/path-identity.js";
import { CONFIG_DIR_NAME } from "../../utils/pi-paths.js";

export function getPackageExtensionSummaryKey(scope: string, source: string): string {
  return `${scope}\0${source}`;
}

export function buildPackageExtensionSummaries(
  entries: PackageExtensionEntry[]
): Map<string, PackageExtensionStateSummary> {
  const summaries = new Map<string, PackageExtensionStateSummary>();

  for (const entry of entries) {
    const key = getPackageExtensionSummaryKey(entry.packageScope, entry.packageSource);
    let summary = summaries.get(key);
    if (!summary) {
      summary = { enabled: 0, disabled: 0, total: 0 };
      summaries.set(key, summary);
    }

    summary.total += 1;
    if (entry.state === "enabled") {
      summary.enabled += 1;
    } else {
      summary.disabled += 1;
    }
  }

  return summaries;
}

function getLocalDisplayName(
  entry: Awaited<ReturnType<typeof discoverExtensions>>[number]
): string {
  const prefix =
    entry.scope === "project" ? `${CONFIG_DIR_NAME}/extensions/` : "global extensions/";
  return entry.displayName.startsWith(prefix)
    ? entry.displayName.slice(prefix.length)
    : entry.displayName;
}

export function buildUnifiedItems(
  localEntries: Awaited<ReturnType<typeof discoverExtensions>>,
  installedPackages: InstalledPackage[],
  knownUpdates: Set<string>,
  packageExtensions: PackageExtensionEntry[] = []
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  const localPaths = new Set<string>();
  const packageSourceCounts = new Map<string, number>();
  for (const pkg of installedPackages) {
    packageSourceCounts.set(pkg.source, (packageSourceCounts.get(pkg.source) ?? 0) + 1);
  }
  const packageExtensionSummaries = buildPackageExtensionSummaries(packageExtensions);
  const packageExtensionPaths = new Map<string, string[]>();
  for (const entry of packageExtensions) {
    const key = getPackageExtensionSummaryKey(entry.packageScope, entry.packageSource);
    const paths = packageExtensionPaths.get(key) ?? [];
    if (!paths.includes(entry.extensionPath)) paths.push(entry.extensionPath);
    packageExtensionPaths.set(key, paths);
  }

  // Add local extensions
  for (const entry of localEntries) {
    const currentPath = entry.state === "disabled" ? entry.disabledPath : entry.activePath;
    localPaths.add(normalizePathIdentity(currentPath));
    items.push({
      type: "local",
      id: entry.id,
      displayName: getLocalDisplayName(entry),
      summary: entry.summary,
      scope: entry.scope,
      state: entry.state,
      activePath: entry.activePath,
      disabledPath: entry.disabledPath,
      originalState: entry.state,
    });
  }

  for (const pkg of installedPackages) {
    const pkgSourceNormalized = normalizePathIdentity(pkg.source);
    const pkgResolvedNormalized = pkg.resolvedPath ? normalizePathIdentity(pkg.resolvedPath) : "";

    let isDuplicate = false;
    for (const localPath of localPaths) {
      if (pkgSourceNormalized === localPath || pkgResolvedNormalized === localPath) {
        isDuplicate = true;
        break;
      }
      if (pkgResolvedNormalized && localPath.startsWith(`${pkgResolvedNormalized}/`)) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    const packageKey = getPackageExtensionSummaryKey(pkg.scope, pkg.source);
    const extensionSummary = packageExtensionSummaries.get(packageKey);
    const extensionPaths = packageExtensionPaths.get(packageKey);

    items.push({
      type: "package",
      id:
        packageSourceCounts.get(pkg.source) === 1
          ? `pkg:${pkg.source}`
          : `pkg:${pkg.source}:${pkg.scope}`,
      displayName: pkg.name,
      scope: pkg.scope,
      source: pkg.source,
      resolvedPath: pkg.resolvedPath,
      version: pkg.version,
      description: pkg.description,
      size: pkg.size,
      updateAvailable: knownUpdates.has(normalizePackageIdentity(pkg.source)),
      ...(extensionSummary ? { extensionSummary } : {}),
      ...(extensionPaths?.length ? { extensionPaths: [...extensionPaths] } : {}),
    });
  }

  // Sort by type then display name.
  items.sort((a, b) => {
    const rank = (type: UnifiedItem["type"]): number => {
      if (type === "local") return 0;
      return 1;
    };

    const diff = rank(a.type) - rank(b.type);
    if (diff !== 0) return diff;
    return a.displayName.localeCompare(b.displayName);
  });

  return items;
}

export function getCurrentUnifiedItemState(
  item: UnifiedItem,
  staged: Map<string, State>
): State | undefined {
  return item.type === "local" ? (staged.get(item.id) ?? item.state) : undefined;
}

export function getLocalItemCurrentPath(item: LocalUnifiedItem, state?: State): string {
  return (state ?? item.state) === "enabled" ? item.activePath : item.disabledPath;
}

export function getToggleItemsForApply(items: UnifiedItem[]): LocalUnifiedItem[] {
  return items.filter((item): item is LocalUnifiedItem => item.type === "local");
}
