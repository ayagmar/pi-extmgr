/**
 * Package discovery and listing
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, NpmPackage, SearchCache } from "../types/index.js";
import { CACHE_TTL, TIMEOUTS } from "../constants.js";
import { readSummary } from "../utils/fs.js";
import { parseNpmSource } from "../utils/format.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  splitGitRepoAndRef,
  stripGitSourcePrefix,
} from "../utils/package-source.js";
import { execNpm } from "../utils/npm-exec.js";
import { fetchWithTimeout } from "../utils/network.js";

const NPM_SEARCH_API = "https://registry.npmjs.org/-/v1/search";
const NPM_SEARCH_PAGE_SIZE = 250;

interface NpmSearchResultObject {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    keywords?: string[];
    date?: string;
  };
}

interface NpmSearchResponse {
  total?: number;
  objects?: NpmSearchResultObject[];
}

let searchCache: SearchCache | null = null;

export function getSearchCache(): SearchCache | null {
  return searchCache;
}

export function setSearchCache(cache: SearchCache | null): void {
  searchCache = cache;
}

export function clearSearchCache(): void {
  searchCache = null;
}

export function isCacheValid(query: string): boolean {
  if (!searchCache) return false;
  if (searchCache.query !== query) return false;
  return Date.now() - searchCache.timestamp < CACHE_TTL;
}

// Import persistent cache
import {
  getCachedSearch,
  setCachedSearch,
  getCachedPackage,
  setCachedPackage,
  getPackageDescriptions,
  getCachedPackageSize,
  setCachedPackageSize,
} from "../utils/cache.js";

function toNpmPackage(entry: NpmSearchResultObject): NpmPackage | undefined {
  const pkg = entry.package;
  if (!pkg) return undefined;

  const name = pkg.name?.trim();
  if (!name) return undefined;

  return {
    name,
    version: pkg.version,
    description: pkg.description,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords : undefined,
    date: pkg.date,
  };
}

async function fetchNpmSearchPage(
  query: string,
  from: number
): Promise<{
  total: number;
  resultCount: number;
  packages: NpmPackage[];
}> {
  const params = new URLSearchParams({
    text: query,
    size: String(NPM_SEARCH_PAGE_SIZE),
    from: String(from),
  });
  const response = await fetchWithTimeout(
    `${NPM_SEARCH_API}?${params.toString()}`,
    TIMEOUTS.npmSearch
  );

  if (!response.ok) {
    throw new Error(`npm registry search failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as NpmSearchResponse;
  const objects = data.objects ?? [];
  const packages = objects.map(toNpmPackage).filter((pkg): pkg is NpmPackage => !!pkg);

  return {
    total:
      typeof data.total === "number" && Number.isFinite(data.total) ? data.total : packages.length,
    resultCount: objects.length,
    packages,
  };
}

export async function fetchNpmRegistrySearchResults(query: string): Promise<NpmPackage[]> {
  const packagesByName = new Map<string, NpmPackage>();
  let from = 0;
  let total = Infinity;

  while (from < total) {
    const page = await fetchNpmSearchPage(query, from);
    total = page.total;

    if (page.resultCount === 0) {
      break;
    }

    for (const pkg of page.packages) {
      if (!packagesByName.has(pkg.name)) {
        packagesByName.set(pkg.name, pkg);
      }
    }

    from += page.resultCount;
  }

  return [...packagesByName.values()];
}

export async function searchNpmPackages(
  query: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<NpmPackage[]> {
  // Check persistent cache first
  const cached = await getCachedSearch(query);
  if (cached && cached.length > 0) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Using ${cached.length} cached results`, "info");
    }
    return cached;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Searching npm for "${query}"...`, "info");
  }

  const packages = await fetchNpmRegistrySearchResults(query);

  // Cache the results
  await setCachedSearch(query, packages);

  return packages;
}

export async function getInstalledPackages(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI,
  onProgress?: (current: number, total: number) => void
): Promise<InstalledPackage[]> {
  const res = await pi.exec("pi", ["list"], { timeout: TIMEOUTS.listPackages, cwd: ctx.cwd });
  if (res.code !== 0) return [];

  const text = res.stdout || "";
  if (!text.trim() || /No packages installed/i.test(text)) {
    return [];
  }

  const packages = parseInstalledPackagesOutput(text);

  // Fetch metadata (descriptions and sizes) for packages in parallel
  await addPackageMetadata(packages, ctx, pi, onProgress);

  return packages;
}

function sanitizeListSourceSuffix(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

function getInstalledPackageIdentity(pkg: InstalledPackage): string {
  return normalizePackageIdentity(
    pkg.source,
    pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : undefined
  );
}

function isScopeHeader(lowerTrimmed: string, scope: "global" | "project"): boolean {
  if (scope === "global") {
    return (
      lowerTrimmed === "global" ||
      lowerTrimmed === "user" ||
      lowerTrimmed.startsWith("global packages") ||
      lowerTrimmed.startsWith("global:") ||
      lowerTrimmed.startsWith("user packages") ||
      lowerTrimmed.startsWith("user:")
    );
  }

  return (
    lowerTrimmed === "project" ||
    lowerTrimmed === "local" ||
    lowerTrimmed.startsWith("project packages") ||
    lowerTrimmed.startsWith("project:") ||
    lowerTrimmed.startsWith("local packages") ||
    lowerTrimmed.startsWith("local:")
  );
}

function looksLikePackageSource(source: string): boolean {
  return getPackageSourceKind(source) !== "unknown";
}

function parseResolvedPathLine(line: string): string | undefined {
  const resolvedMatch = line.match(/^resolved\s*:\s*(.+)$/i);
  if (resolvedMatch?.[1]) {
    return resolvedMatch[1].trim();
  }

  if (
    line.startsWith("/") ||
    line.startsWith("./") ||
    line.startsWith("../") ||
    line.startsWith(".\\") ||
    line.startsWith("..\\") ||
    line.startsWith("~/") ||
    line.startsWith("file://") ||
    /^[a-zA-Z]:[\\/]/.test(line) ||
    line.startsWith("\\\\")
  ) {
    return line;
  }

  return undefined;
}

function parseInstalledPackagesOutputInternal(text: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];

  const lines = text.split("\n");
  let currentScope: "global" | "project" = "global";
  let currentPackage: InstalledPackage | undefined;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    const isIndented = /^(?:\t+|\s{4,})/.test(rawLine);
    const trimmed = rawLine.trim();

    if (isIndented && currentPackage) {
      const resolved = parseResolvedPathLine(trimmed);
      if (resolved) {
        currentPackage.resolvedPath = resolved;
      }
      continue;
    }

    const lowerTrimmed = trimmed.toLowerCase();
    if (isScopeHeader(lowerTrimmed, "global")) {
      currentScope = "global";
      currentPackage = undefined;
      continue;
    }
    if (isScopeHeader(lowerTrimmed, "project")) {
      currentScope = "project";
      currentPackage = undefined;
      continue;
    }

    const candidate = trimmed.replace(/^[-•]?\s*/, "").trim();
    if (!looksLikePackageSource(candidate)) continue;

    const source = sanitizeListSourceSuffix(candidate);
    const { name, version } = parsePackageNameAndVersion(source);

    const pkg: InstalledPackage = { source, name, scope: currentScope };
    if (version !== undefined) {
      pkg.version = version;
    }
    packages.push(pkg);
    currentPackage = pkg;
  }

  return packages;
}

function shouldReplaceInstalledPackage(
  current: InstalledPackage | undefined,
  candidate: InstalledPackage
): boolean {
  if (!current) {
    return true;
  }

  if (current.scope !== candidate.scope) {
    return candidate.scope === "project";
  }

  return false;
}

export function parseInstalledPackagesOutput(text: string): InstalledPackage[] {
  const parsed = parseInstalledPackagesOutputInternal(text);
  const deduped = new Map<string, InstalledPackage>();

  for (const pkg of parsed) {
    const identity = getInstalledPackageIdentity(pkg);
    const current = deduped.get(identity);
    if (shouldReplaceInstalledPackage(current, pkg)) {
      deduped.set(identity, pkg);
    }
  }

  return Array.from(deduped.values());
}

/**
 * Check whether a specific package source is installed.
 * Matches on normalized package source and optional scope.
 */
export async function isSourceInstalled(
  source: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI,
  options?: { scope?: "global" | "project" }
): Promise<boolean> {
  try {
    const res = await pi.exec("pi", ["list"], { timeout: TIMEOUTS.listPackages, cwd: ctx.cwd });
    if (res.code !== 0) return false;

    const installed = parseInstalledPackagesOutputAllScopes(res.stdout || "");
    const expected = normalizePackageIdentity(source);

    return installed.some((pkg) => {
      if (getInstalledPackageIdentity(pkg) !== expected) {
        return false;
      }
      return options?.scope ? pkg.scope === options.scope : true;
    });
  } catch {
    return false;
  }
}

/**
 * parseInstalledPackagesOutputAllScopes returns the raw parsed entries from
 * parseInstalledPackagesOutputInternal without deduplication or scope merging.
 * Prefer parseInstalledPackagesOutput for user-facing lists, since it applies
 * deduplication and normalized scope selection.
 */
export function parseInstalledPackagesOutputAllScopes(text: string): InstalledPackage[] {
  return parseInstalledPackagesOutputInternal(text);
}

function extractGitPackageName(repoSpec: string): string {
  // git@github.com:user/repo(.git)
  if (repoSpec.startsWith("git@")) {
    const afterColon = repoSpec.split(":").slice(1).join(":");
    if (afterColon) {
      const last = afterColon.split("/").pop() || afterColon;
      return last.replace(/\.git$/i, "") || repoSpec;
    }
  }

  // https://..., ssh://..., git://...
  try {
    const url = new URL(repoSpec);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last) {
      return last.replace(/\.git$/i, "") || repoSpec;
    }
  } catch {
    // Fallback below
  }

  const last = repoSpec.split(/[/:]/).filter(Boolean).pop();
  return (last ? last.replace(/\.git$/i, "") : repoSpec) || repoSpec;
}

function parsePackageNameAndVersion(fullSource: string): {
  name: string;
  version?: string | undefined;
} {
  const parsedNpm = parseNpmSource(fullSource);
  if (parsedNpm) {
    return parsedNpm;
  }

  const sourceKind = getPackageSourceKind(fullSource);
  if (sourceKind === "git") {
    const gitSpec = stripGitSourcePrefix(fullSource);
    const { repo } = splitGitRepoAndRef(gitSpec);
    return { name: extractGitPackageName(repo) };
  }

  if (fullSource.includes("node_modules/")) {
    const nmMatch = fullSource.match(/node_modules\/(.+)$/);
    if (nmMatch?.[1]) {
      return { name: nmMatch[1] };
    }
  }

  const pathParts = fullSource.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1];
  return { name: fileName || fullSource };
}

async function hydratePackageFromResolvedPath(pkg: InstalledPackage): Promise<void> {
  if (!pkg.resolvedPath) return;

  const manifestPath = /(?:^|[\\/])package\.json$/i.test(pkg.resolvedPath)
    ? pkg.resolvedPath
    : join(pkg.resolvedPath, "package.json");

  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
    };

    if (!pkg.version && typeof manifest.version === "string" && manifest.version.trim()) {
      pkg.version = manifest.version.trim();
    }

    if (
      !pkg.description &&
      typeof manifest.description === "string" &&
      manifest.description.trim()
    ) {
      pkg.description = manifest.description.trim();
    }

    if (
      (!pkg.name || pkg.name === pkg.source) &&
      typeof manifest.name === "string" &&
      manifest.name.trim()
    ) {
      pkg.name = manifest.name.trim();
    }
  } catch {
    // ignore
  }
}

/**
 * Fetch package size from npm view
 */
async function fetchPackageSize(
  pkgName: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<number | undefined> {
  // Check cache first
  const cachedSize = await getCachedPackageSize(pkgName);
  if (cachedSize !== undefined) return cachedSize;

  try {
    // Try to get unpacked size from npm view
    const res = await execNpm(pi, ["view", pkgName, "dist.unpackedSize", "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
    });
    if (res.code === 0) {
      try {
        const size = JSON.parse(res.stdout) as number;
        if (typeof size === "number" && size > 0) {
          await setCachedPackageSize(pkgName, size);
          return size;
        }
      } catch {
        // Ignore parse errors
      }
    }
  } catch {
    // Silently ignore errors
  }
  return undefined;
}

async function addPackageMetadata(
  packages: InstalledPackage[],
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  // First, try to get descriptions from cache
  const cachedDescriptions = await getPackageDescriptions(packages);
  for (const [source, description] of cachedDescriptions) {
    const pkg = packages.find((p) => p.source === source);
    if (pkg) pkg.description = description;
  }

  // Process remaining packages in batches
  const batchSize = 5;
  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);

    // Report progress
    onProgress?.(i, packages.length);

    await Promise.all(
      batch.map(async (pkg) => {
        await hydratePackageFromResolvedPath(pkg);

        const needsDescription = !pkg.description;
        const needsSize = pkg.size === undefined && pkg.source.startsWith("npm:");

        if (!needsDescription && !needsSize) return;

        try {
          if (pkg.source.endsWith(".ts") || pkg.source.endsWith(".js")) {
            if (needsDescription) {
              pkg.description = await readSummary(pkg.source);
            }
          } else if (pkg.source.startsWith("npm:")) {
            const parsed = parseNpmSource(pkg.source);
            const pkgName = parsed?.name;

            if (pkgName) {
              if (needsDescription) {
                const cached = await getCachedPackage(pkgName);
                if (cached?.description) {
                  pkg.description = cached.description;
                } else {
                  const res = await execNpm(pi, ["view", pkgName, "description", "--json"], ctx, {
                    timeout: TIMEOUTS.npmView,
                  });
                  if (res.code === 0) {
                    try {
                      const desc = JSON.parse(res.stdout) as string;
                      if (typeof desc === "string" && desc) {
                        pkg.description = desc;
                        await setCachedPackage(pkgName, {
                          name: pkgName,
                          description: desc,
                        });
                      }
                    } catch {
                      // Ignore parse errors
                    }
                  }
                }
              }

              if (needsSize) {
                pkg.size = await fetchPackageSize(pkgName, ctx, pi);
              }
            }
          } else if (pkg.source.startsWith("git:")) {
            if (needsDescription) pkg.description = "git repository";
          } else {
            if (needsDescription) pkg.description = "local package";
          }
        } catch {
          // Silently ignore fetch errors
        }
      })
    );
  }

  // Final progress update
  onProgress?.(packages.length, packages.length);
}
