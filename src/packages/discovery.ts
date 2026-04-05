/**
 * Package discovery and listing
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { CACHE_TTL, TIMEOUTS } from "../constants.js";
import { type InstalledPackage, type NpmPackage, type SearchCache } from "../types/index.js";
import { parseNpmSource } from "../utils/format.js";
import { readSummary } from "../utils/fs.js";
import { fetchWithTimeout } from "../utils/network.js";
import { execNpm } from "../utils/npm-exec.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { getPackageCatalog } from "./catalog.js";

const NPM_SEARCH_API = "https://registry.npmjs.org/-/v1/search";
const NPM_SEARCH_PAGE_SIZE = 250;

interface NpmSearchResultObject {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    keywords?: string[];
    date?: string;
    publisher?: {
      username?: string;
      email?: string;
    };
    maintainers?: Array<{
      username?: string;
      email?: string;
    }>;
  };
}

interface NpmSearchResponse {
  total?: number;
  objects?: NpmSearchResultObject[];
}

let searchCache: SearchCache | null = null;

function createAbortError(): Error {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

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
  getCachedPackage,
  getCachedPackageSize,
  getCachedSearch,
  getPackageDescriptions,
  setCachedPackage,
  setCachedPackageSize,
  setCachedSearch,
} from "../utils/cache.js";

function getNpmPackageAuthor(
  pkg: NonNullable<NpmSearchResultObject["package"]>
): string | undefined {
  const publisher = pkg.publisher;
  if (publisher?.username?.trim()) {
    return publisher.username.trim();
  }

  if (publisher?.email?.trim()) {
    return publisher.email.trim();
  }

  const maintainerWithUsername = pkg.maintainers?.find((entry) => entry.username?.trim());
  if (maintainerWithUsername?.username?.trim()) {
    return maintainerWithUsername.username.trim();
  }

  const maintainerWithEmail = pkg.maintainers?.find((entry) => entry.email?.trim());
  if (maintainerWithEmail?.email?.trim()) {
    return maintainerWithEmail.email.trim();
  }

  return undefined;
}

function toNpmPackage(entry: NpmSearchResultObject): NpmPackage | undefined {
  const pkg = entry.package;
  if (!pkg) return undefined;

  const name = pkg.name?.trim();
  if (!name) return undefined;

  return {
    name,
    version: pkg.version,
    description: pkg.description,
    author: getNpmPackageAuthor(pkg),
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords : undefined,
    date: pkg.date,
  };
}

async function fetchNpmSearchPage(
  query: string,
  from: number,
  signal?: AbortSignal
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
    TIMEOUTS.npmSearch,
    signal
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

export async function fetchNpmRegistrySearchResults(
  query: string,
  signal?: AbortSignal
): Promise<NpmPackage[]> {
  const packagesByName = new Map<string, NpmPackage>();
  let from = 0;
  let total = Infinity;

  while (from < total) {
    const page = await fetchNpmSearchPage(query, from, signal);
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
  options?: { signal?: AbortSignal }
): Promise<NpmPackage[]> {
  const cached = await getCachedSearch(query);
  if (cached) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Using ${cached.length} cached results`, "info");
    }
    return cached;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Searching npm for "${query}"...`, "info");
  }

  const packages = await fetchNpmRegistrySearchResults(query, options?.signal);

  // Cache the results
  await setCachedSearch(query, packages);

  return packages;
}

export async function getInstalledPackages(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<InstalledPackage[]> {
  throwIfAborted(signal);

  const packages = await getPackageCatalog(ctx.cwd).listInstalledPackages();
  if (packages.length === 0) {
    return [];
  }

  await addPackageMetadata(packages, ctx, pi, onProgress, signal);
  throwIfAborted(signal);
  return packages;
}

function getInstalledPackageIdentity(pkg: InstalledPackage, options?: { cwd?: string }): string {
  const baseCwd = pkg.scope === "project" ? options?.cwd : getAgentDir();

  return normalizePackageIdentity(pkg.source, {
    ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
    ...(baseCwd ? { cwd: baseCwd } : {}),
  });
}

export async function isSourceInstalled(
  source: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  options?: { scope?: "global" | "project" }
): Promise<boolean> {
  const installed = await getPackageCatalog(ctx.cwd).listInstalledPackages({ dedupe: false });
  const expected = normalizePackageIdentity(source, { cwd: ctx.cwd });

  return installed.some((pkg) => {
    if (getInstalledPackageIdentity(pkg, { cwd: ctx.cwd }) !== expected) {
      return false;
    }
    return options?.scope ? pkg.scope === options.scope : true;
  });
}

export async function getInstalledPackagesAllScopes(
  ctx: ExtensionCommandContext | ExtensionContext
): Promise<InstalledPackage[]> {
  return getPackageCatalog(ctx.cwd).listInstalledPackages({ dedupe: false });
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
  pi: ExtensionAPI,
  signal?: AbortSignal
): Promise<number | undefined> {
  // Check cache first
  const cachedSize = await getCachedPackageSize(pkgName);
  if (cachedSize !== undefined) return cachedSize;

  try {
    // Try to get unpacked size from npm view
    const res = await execNpm(pi, ["view", pkgName, "dist.unpackedSize", "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
      ...(signal ? { signal } : {}),
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
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);

  const cachedDescriptions = await getPackageDescriptions(packages);
  for (const [source, description] of cachedDescriptions) {
    const pkg = packages.find((p) => p.source === source);
    if (pkg) pkg.description = description;
  }

  const batchSize = 5;
  for (let i = 0; i < packages.length; i += batchSize) {
    throwIfAborted(signal);

    const batch = packages.slice(i, i + batchSize);

    onProgress?.(i, packages.length);

    await Promise.all(
      batch.map(async (pkg) => {
        throwIfAborted(signal);

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
                    ...(signal ? { signal } : {}),
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
                pkg.size = await fetchPackageSize(pkgName, ctx, pi, signal);
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

    throwIfAborted(signal);
  }

  onProgress?.(packages.length, packages.length);
}
