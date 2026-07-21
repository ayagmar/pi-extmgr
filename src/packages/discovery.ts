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
} from "@earendil-works/pi-coding-agent";
import { CACHE_LIMITS, PAGE_SIZE, TIMEOUTS } from "../constants.js";
import { createAbortError, throwIfAborted } from "../utils/abort.js";
import { type InstalledPackage, type NpmPackage, type SearchCache } from "../types/index.js";
import {
  getCachedPackage,
  getCachedPackageSize,
  getCachedSearch,
  getPackageDescriptions,
  setCachedPackage,
  setCachedPackageSize,
  setCachedSearch,
} from "../utils/cache.js";
import { parseNpmSource } from "../utils/format.js";
import { readSummary } from "../utils/fs.js";
import { isProjectTrusted } from "../utils/mode.js";
import { fetchWithTimeout } from "../utils/network.js";
import { execNpm } from "../utils/npm-exec.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { getPackageCatalog } from "./catalog.js";

const NPM_SEARCH_API = "https://registry.npmjs.org/-/v1/search";
const NPM_SEARCH_MAX_PAGE_SIZE = 250;
const NPM_SEARCH_MAX_RETRIES = 2;
const NPM_SEARCH_RETRY_DELAY_MS = 1_000;

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

interface NpmDownloadsPoint {
  downloads?: number;
}

const searchCacheByPage = new Map<string, SearchCache>();
let latestSearchCacheKey: string | undefined;

function getSearchCacheKey(query: string, offset: number): string {
  return `${offset}\0${query}`;
}

export function getSearchCache(query?: string, offset = 0): SearchCache | null {
  const key = query ? getSearchCacheKey(query, offset) : latestSearchCacheKey;
  return key ? (searchCacheByPage.get(key) ?? null) : null;
}

export function setSearchCache(cache: SearchCache): void {
  const key = getSearchCacheKey(cache.query, cache.offset);
  searchCacheByPage.set(key, cache);
  latestSearchCacheKey = key;
}

export function clearSearchCache(query?: string): void {
  if (!query) {
    searchCacheByPage.clear();
    latestSearchCacheKey = undefined;
    return;
  }

  for (const [key, cache] of searchCacheByPage) {
    if (cache.query === query) {
      searchCacheByPage.delete(key);
    }
  }

  if (latestSearchCacheKey && !searchCacheByPage.has(latestSearchCacheKey)) {
    latestSearchCacheKey = undefined;
  }
}

export function isCacheValid(query: string, offset = 0): boolean {
  const cache = getSearchCache(query, offset);
  return cache ? Date.now() - cache.timestamp < CACHE_LIMITS.searchTTL : false;
}

export async function hydrateSearchCache(query: string, offset = 0): Promise<SearchCache | null> {
  const cached = await getCachedSearch(query, offset);
  if (cached) setSearchCache(cached);
  return cached;
}

function getNpmPackageAuthor(
  pkg: NonNullable<NpmSearchResultObject["package"]>
): string | undefined {
  const publisher = pkg.publisher;
  if (publisher?.username?.trim()) {
    return publisher.username.trim();
  }

  const maintainerWithUsername = pkg.maintainers?.find((entry) => entry.username?.trim());
  if (maintainerWithUsername?.username?.trim()) {
    return maintainerWithUsername.username.trim();
  }

  if (publisher?.email?.trim()) {
    return publisher.email.trim();
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

function getRetryDelayMs(response: Response, retryNumber: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, TIMEOUTS.npmSearch);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), TIMEOUTS.npmSearch);
    }
  }

  return NPM_SEARCH_RETRY_DELAY_MS * 2 ** (retryNumber - 1);
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchNpmRegistrySearchPage(
  query: string,
  from = 0,
  signal?: AbortSignal,
  size = PAGE_SIZE
): Promise<SearchCache> {
  const pageSize = Number.isFinite(size)
    ? Math.max(1, Math.min(Math.floor(size), NPM_SEARCH_MAX_PAGE_SIZE))
    : PAGE_SIZE;
  const offset = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
  const params = new URLSearchParams({
    text: query,
    size: String(pageSize),
    from: String(offset),
  });
  const url = `${NPM_SEARCH_API}?${params.toString()}`;

  let response: Response | undefined;
  for (let attempt = 0; attempt <= NPM_SEARCH_MAX_RETRIES; attempt += 1) {
    response = await fetchWithTimeout(url, TIMEOUTS.npmSearch, signal);
    if (response.status !== 429 || attempt === NPM_SEARCH_MAX_RETRIES) {
      break;
    }

    await response.body?.cancel();
    await waitForRetry(getRetryDelayMs(response, attempt + 1), signal);
  }

  if (!response?.ok) {
    if (response?.status === 429) {
      throw new Error("npm registry search is rate-limited (HTTP 429). Try again shortly.");
    }
    throw new Error(`npm registry search failed: HTTP ${response?.status ?? "unknown"}`);
  }

  const data = (await response.json()) as NpmSearchResponse;
  const objects = data.objects ?? [];
  const results = objects.map(toNpmPackage).filter((pkg): pkg is NpmPackage => !!pkg);
  const total =
    typeof data.total === "number" && Number.isFinite(data.total) && data.total >= 0
      ? data.total
      : offset + results.length;

  return {
    query,
    results,
    total,
    offset,
    timestamp: Date.now(),
  };
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted && error instanceof Error && error.name === "AbortError") throw error;
}

async function fetchWeeklyDownloadsPoint(
  name: string,
  downloads: Map<string, number>,
  signal?: AbortSignal
): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
      TIMEOUTS.weeklyDownloads,
      signal
    );
    if (!response.ok) return;
    const payload = (await response.json()) as NpmDownloadsPoint;
    if (typeof payload.downloads === "number") downloads.set(name, payload.downloads);
  } catch (error) {
    rethrowIfAborted(error, signal);
  }
}

async function fetchWeeklyDownloadsBulk(
  names: readonly string[],
  downloads: Map<string, number>,
  signal?: AbortSignal
): Promise<void> {
  try {
    const encodedNames = names.map((name) => encodeURIComponent(name)).join(",");
    const response = await fetchWithTimeout(
      `https://api.npmjs.org/downloads/point/last-week/${encodedNames}`,
      TIMEOUTS.weeklyDownloads,
      signal
    );
    if (!response.ok) return;

    const payload = (await response.json()) as Record<
      string,
      NpmDownloadsPoint | number | string | undefined
    >;
    for (const name of names) {
      const point = payload[name];
      if (point && typeof point === "object" && typeof point.downloads === "number") {
        downloads.set(name, point.downloads);
      }
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
  }
}

export async function fetchNpmWeeklyDownloads(
  packageNames: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const names = [...new Set(packageNames.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return new Map();

  // npm's bulk downloads endpoint rejects scoped packages; they need point lookups.
  const scoped = names.filter((name) => name.startsWith("@"));
  const unscoped = names.filter((name) => !name.startsWith("@"));
  const downloads = new Map<string, number>();
  const tasks: Promise<void>[] = [];

  if (unscoped.length === 1) {
    tasks.push(fetchWeeklyDownloadsPoint(unscoped[0] as string, downloads, signal));
  } else if (unscoped.length > 1) {
    tasks.push(fetchWeeklyDownloadsBulk(unscoped, downloads, signal));
  }
  for (const name of scoped) {
    tasks.push(fetchWeeklyDownloadsPoint(name, downloads, signal));
  }

  await Promise.all(tasks);
  return downloads;
}

export async function addWeeklyDownloadsToSearchPage(
  page: SearchCache,
  signal?: AbortSignal
): Promise<SearchCache> {
  // Skip packages whose metrics are already known to avoid repeated fetches.
  const missing = page.results
    .filter((pkg) => pkg.weeklyDownloads === undefined)
    .map((pkg) => pkg.name);
  if (missing.length === 0) return page;

  const downloads = await fetchNpmWeeklyDownloads(missing, signal);
  if (downloads.size === 0) return page;

  for (const pkg of page.results) {
    const weeklyDownloads = downloads.get(pkg.name);
    if (weeklyDownloads !== undefined) pkg.weeklyDownloads = weeklyDownloads;
  }
  setSearchCache(page);
  await setCachedSearch(page);
  return page;
}

export async function searchNpmPackages(
  query: string,
  ctx: ExtensionCommandContext,
  options?: { signal?: AbortSignal; offset?: number; size?: number; forceRefresh?: boolean }
): Promise<SearchCache> {
  const offset = options?.offset ?? 0;

  if (!options?.forceRefresh) {
    const runtimeCached = getSearchCache(query, offset);
    if (runtimeCached && isCacheValid(query, offset)) {
      return runtimeCached;
    }

    const persisted = await hydrateSearchCache(query, offset);
    if (persisted) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Using ${persisted.results.length} cached results`, "info");
      }
      return persisted;
    }
  }

  const page = await fetchNpmRegistrySearchPage(query, offset, options?.signal, options?.size);
  setSearchCache(page);
  await setCachedSearch(page);
  return page;
}

export async function getInstalledPackages(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<InstalledPackage[]> {
  throwIfAborted(signal);

  const packages = await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).listInstalledPackages();
  if (packages.length === 0) {
    return [];
  }

  await addPackageMetadata(packages, ctx, pi, onProgress, signal);
  throwIfAborted(signal);
  return packages;
}

function getInstalledPackageIdentity(pkg: InstalledPackage, options?: { cwd?: string }): string {
  const baseCwd =
    pkg.scope === "project"
      ? options?.cwd
        ? getProjectConfigDir(options.cwd)
        : undefined
      : getAgentDir();

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
  const installed = await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).listInstalledPackages({
    dedupe: false,
  });
  return installed.some((pkg) => {
    if (options?.scope && pkg.scope !== options.scope) return false;
    const baseCwds =
      pkg.scope === "project" ? [ctx.cwd, getProjectConfigDir(ctx.cwd)] : [getAgentDir(), ctx.cwd];
    const actual = getInstalledPackageIdentity(pkg, { cwd: ctx.cwd });
    return baseCwds.some(
      (baseCwd) => normalizePackageIdentity(source, { cwd: baseCwd }) === actual
    );
  });
}

export async function getInstalledPackagesAllScopes(
  ctx: ExtensionCommandContext | ExtensionContext
): Promise<InstalledPackage[]> {
  return getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).listInstalledPackages({ dedupe: false });
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
