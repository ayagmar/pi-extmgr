/**
 * Persistent cache for package metadata to reduce npm API calls
 */
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_LIMITS } from "../constants.js";
import { type InstalledPackage, type NpmPackage } from "../types/index.js";
import { parseNpmSource } from "./format.js";

const CACHE_DIR = process.env.PI_EXTMGR_CACHE_DIR
  ? process.env.PI_EXTMGR_CACHE_DIR
  : join(homedir(), ".pi", "agent", ".extmgr-cache");
const CACHE_FILE = join(CACHE_DIR, "metadata.json");
const CURRENT_SEARCH_CACHE_STRATEGY = "npm-registry-v1-paginated";
const CACHED_PACKAGE_FIELDS = [
  "description",
  "version",
  "author",
  "keywords",
  "date",
  "size",
] as const;

type CachedPackageField = (typeof CACHED_PACKAGE_FIELDS)[number];

interface CachedPackageData {
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  author?: string | undefined;
  keywords?: string[] | undefined;
  date?: string | undefined;
  size?: number | undefined;
  timestamp: number;
  fieldTimestamps?: Partial<Record<CachedPackageField, number>> | undefined;
}

interface CacheData {
  version: number;
  packages: Map<string, CachedPackageData>;
  lastSearch?:
    | {
        query: string;
        results: string[];
        timestamp: number;
        strategy: string;
      }
    | undefined;
}

let memoryCache: CacheData | null = null;
let cacheWriteQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCachedPackageEntry(key: string, value: unknown): CachedPackageData | undefined {
  if (!isRecord(value)) return undefined;

  const timestamp = value.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }

  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : key;
  const entry: CachedPackageData = {
    name,
    timestamp,
  };
  const rawFieldTimestamps = isRecord(value.fieldTimestamps) ? value.fieldTimestamps : undefined;

  const getFieldTimestamp = (field: CachedPackageField): number => {
    const fieldTimestamp = rawFieldTimestamps?.[field];
    return typeof fieldTimestamp === "number" &&
      Number.isFinite(fieldTimestamp) &&
      fieldTimestamp > 0
      ? fieldTimestamp
      : timestamp;
  };

  if (typeof value.description === "string") {
    entry.description = value.description;
    entry.fieldTimestamps = {
      ...entry.fieldTimestamps,
      description: getFieldTimestamp("description"),
    };
  }

  if (typeof value.version === "string") {
    entry.version = value.version;
    entry.fieldTimestamps = {
      ...entry.fieldTimestamps,
      version: getFieldTimestamp("version"),
    };
  }

  if (typeof value.author === "string") {
    entry.author = value.author;
    entry.fieldTimestamps = {
      ...entry.fieldTimestamps,
      author: getFieldTimestamp("author"),
    };
  }

  if (Array.isArray(value.keywords)) {
    const keywords = value.keywords.filter((item): item is string => typeof item === "string");
    if (keywords.length > 0) {
      entry.keywords = keywords;
      entry.fieldTimestamps = {
        ...entry.fieldTimestamps,
        keywords: getFieldTimestamp("keywords"),
      };
    }
  }

  if (typeof value.date === "string") {
    entry.date = value.date;
    entry.fieldTimestamps = {
      ...entry.fieldTimestamps,
      date: getFieldTimestamp("date"),
    };
  }

  if (typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0) {
    entry.size = value.size;
    entry.fieldTimestamps = {
      ...entry.fieldTimestamps,
      size: getFieldTimestamp("size"),
    };
  }

  return entry;
}

function normalizeCacheFromDisk(input: unknown): CacheData {
  if (!isRecord(input)) {
    return { version: 1, packages: new Map() };
  }

  const version =
    typeof input.version === "number" && Number.isFinite(input.version) ? input.version : 1;

  const packages = new Map<string, CachedPackageData>();
  const rawPackages = isRecord(input.packages) ? input.packages : {};

  for (const [name, value] of Object.entries(rawPackages)) {
    const normalized = normalizeCachedPackageEntry(name, value);
    if (normalized) {
      packages.set(name, normalized);
    }
  }

  let lastSearch: CacheData["lastSearch"];
  if (isRecord(input.lastSearch)) {
    const query = input.lastSearch.query;
    const timestamp = input.lastSearch.timestamp;
    const results = input.lastSearch.results;
    const strategy = input.lastSearch.strategy;

    if (
      typeof query === "string" &&
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      Array.isArray(results) &&
      typeof strategy === "string" &&
      strategy.trim()
    ) {
      const normalizedResults = results.filter(
        (value): value is string => typeof value === "string"
      );
      lastSearch = {
        query,
        timestamp,
        results: normalizedResults,
        strategy: strategy.trim(),
      };
    }
  }

  return {
    version,
    packages,
    lastSearch,
  };
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir(): Promise<void> {
  try {
    await access(CACHE_DIR);
  } catch {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

async function backupCorruptCacheFile(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(CACHE_DIR, `metadata.invalid-${stamp}.json`);

  try {
    await rename(CACHE_FILE, backupPath);
    console.warn(`[extmgr] Invalid metadata cache JSON. Backed up to ${backupPath}.`);
  } catch (error) {
    console.warn("[extmgr] Failed to backup invalid cache file:", error);
  }
}

/**
 * Load cache from disk
 */
async function loadCache(): Promise<CacheData> {
  if (memoryCache) return memoryCache;

  try {
    await ensureCacheDir();
    const data = await readFile(CACHE_FILE, "utf8");
    const trimmed = data.trim();

    if (!trimmed) {
      memoryCache = {
        version: 1,
        packages: new Map(),
      };
      return memoryCache;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      memoryCache = normalizeCacheFromDisk(parsed);
    } catch {
      await backupCorruptCacheFile();
      memoryCache = {
        version: 1,
        packages: new Map(),
      };
    }
  } catch (error) {
    // Cache doesn't exist or is unreadable, start fresh
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      console.warn("[extmgr] Cache load failed, resetting:", error.message);
    }
    memoryCache = {
      version: 1,
      packages: new Map(),
    };
  }

  return memoryCache;
}

/**
 * Save cache to disk
 */
async function saveCache(): Promise<void> {
  if (!memoryCache) return;

  await ensureCacheDir();

  const data: {
    version: number;
    packages: Record<string, CachedPackageData>;
    lastSearch?:
      | { query: string; results: string[]; timestamp: number; strategy: string }
      | undefined;
  } = {
    version: memoryCache.version,
    packages: Object.fromEntries(memoryCache.packages),
    lastSearch: memoryCache.lastSearch,
  };

  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = join(CACHE_DIR, `metadata.${process.pid}.${Date.now()}.tmp`);

  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, CACHE_FILE);
  } catch {
    // Fallback for filesystems where rename-overwrite can fail.
    await writeFile(CACHE_FILE, content, "utf8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

async function enqueueCacheSave(): Promise<void> {
  cacheWriteQueue = cacheWriteQueue
    .catch(() => undefined)
    .then(() => saveCache())
    .catch((error) => {
      console.warn("[extmgr] Cache save failed:", error instanceof Error ? error.message : error);
    });

  return cacheWriteQueue;
}

function setCachedPackageField(
  data: CachedPackageData,
  field: CachedPackageField,
  value: CachedPackageData[CachedPackageField],
  timestamp: number
): void {
  switch (field) {
    case "description":
      data.description = value as string | undefined;
      break;
    case "version":
      data.version = value as string | undefined;
      break;
    case "author":
      data.author = value as string | undefined;
      break;
    case "keywords":
      data.keywords = value as string[] | undefined;
      break;
    case "date":
      data.date = value as string | undefined;
      break;
    case "size":
      data.size = value as number | undefined;
      break;
  }

  data.fieldTimestamps = {
    ...data.fieldTimestamps,
    [field]: timestamp,
  };
}

function getCachedFieldTimestamp(data: CachedPackageData, field: CachedPackageField): number {
  return data.fieldTimestamps?.[field] ?? data.timestamp;
}

function mergeCachedPackageData(
  existing: CachedPackageData | undefined,
  next: Omit<CachedPackageData, "timestamp" | "fieldTimestamps">
): CachedPackageData {
  const timestamp = Date.now();
  const merged: CachedPackageData = {
    name: next.name || existing?.name || "",
    timestamp,
  };

  for (const field of CACHED_PACKAGE_FIELDS) {
    const nextValue = next[field];
    if (nextValue !== undefined) {
      setCachedPackageField(merged, field, nextValue, timestamp);
      continue;
    }

    const existingValue = existing?.[field];
    if (existingValue !== undefined && existing) {
      setCachedPackageField(merged, field, existingValue, getCachedFieldTimestamp(existing, field));
    }
  }

  return merged;
}

/**
 * Check if cached data is still valid (within TTL)
 */
function isCacheValid(timestamp: number | undefined): boolean {
  return typeof timestamp === "number" && Date.now() - timestamp < CACHE_LIMITS.metadataTTL;
}

function getFreshCachedField(
  data: CachedPackageData,
  field: CachedPackageField
): CachedPackageData[CachedPackageField] | undefined {
  const value = data[field];
  if (value === undefined) {
    return undefined;
  }

  return isCacheValid(getCachedFieldTimestamp(data, field)) ? value : undefined;
}

function hasFreshCachedField(data: CachedPackageData): boolean {
  return CACHED_PACKAGE_FIELDS.some((field) => {
    const value = data[field];
    return value !== undefined && isCacheValid(getCachedFieldTimestamp(data, field));
  });
}

function toFreshCachedPackage(data: CachedPackageData | undefined): CachedPackageData | null {
  if (!data) {
    return null;
  }

  const fresh: CachedPackageData = {
    name: data.name,
    timestamp: data.timestamp,
  };
  let hasFreshField = false;

  for (const field of CACHED_PACKAGE_FIELDS) {
    const value = getFreshCachedField(data, field);
    if (value === undefined) {
      continue;
    }

    hasFreshField = true;
    setCachedPackageField(fresh, field, value, getCachedFieldTimestamp(data, field));
  }

  return hasFreshField ? fresh : null;
}

/**
 * Get cached package data
 */
export async function getCachedPackage(name: string): Promise<CachedPackageData | null> {
  const cache = await loadCache();
  return toFreshCachedPackage(cache.packages.get(name));
}

/**
 * Set cached package data
 */
export async function setCachedPackage(
  name: string,
  data: Omit<CachedPackageData, "timestamp" | "fieldTimestamps">
): Promise<void> {
  const cache = await loadCache();
  cache.packages.set(name, mergeCachedPackageData(cache.packages.get(name), data));
  await enqueueCacheSave();
}

/**
 * Get cached search results
 */
export async function getCachedSearch(query: string): Promise<NpmPackage[] | null> {
  const cache = await loadCache();

  if (!cache.lastSearch || cache.lastSearch.query !== query) {
    return null;
  }

  if (Date.now() - cache.lastSearch.timestamp >= CACHE_LIMITS.searchTTL) {
    return null;
  }

  if (cache.lastSearch.strategy !== CURRENT_SEARCH_CACHE_STRATEGY) {
    return null;
  }

  // Reconstruct packages from cached names
  const packages: NpmPackage[] = [];
  for (const name of cache.lastSearch.results) {
    const pkg = cache.packages.get(name);
    if (pkg) {
      packages.push({
        name: pkg.name,
        description: getFreshCachedField(pkg, "description") as string | undefined,
        version: getFreshCachedField(pkg, "version") as string | undefined,
        author: getFreshCachedField(pkg, "author") as string | undefined,
        keywords: getFreshCachedField(pkg, "keywords") as string[] | undefined,
        date: getFreshCachedField(pkg, "date") as string | undefined,
        size: getFreshCachedField(pkg, "size") as number | undefined,
      });
    }
  }

  return packages;
}

/**
 * Set cached search results
 */
export async function setCachedSearch(query: string, packages: NpmPackage[]): Promise<void> {
  const cache = await loadCache();

  // Update cache with new packages
  for (const pkg of packages) {
    cache.packages.set(
      pkg.name,
      mergeCachedPackageData(cache.packages.get(pkg.name), {
        name: pkg.name,
        description: pkg.description ?? undefined,
        version: pkg.version ?? undefined,
        author: pkg.author ?? undefined,
        keywords: pkg.keywords ?? undefined,
        date: pkg.date ?? undefined,
        size: pkg.size ?? undefined,
      })
    );
  }

  // Store search results
  cache.lastSearch = {
    query,
    results: packages.map((p) => p.name),
    timestamp: Date.now(),
    strategy: CURRENT_SEARCH_CACHE_STRATEGY,
  };

  await enqueueCacheSave();
}

/**
 * Clear all cached data
 */
export async function clearCache(): Promise<void> {
  memoryCache = {
    version: 1,
    packages: new Map(),
  };
  await enqueueCacheSave();
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  totalPackages: number;
  validEntries: number;
  expiredEntries: number;
}> {
  const cache = await loadCache();
  let valid = 0;
  let expired = 0;

  for (const [, data] of cache.packages) {
    if (hasFreshCachedField(data)) {
      valid++;
    } else {
      expired++;
    }
  }

  return {
    totalPackages: cache.packages.size,
    validEntries: valid,
    expiredEntries: expired,
  };
}

/**
 * Batch get descriptions for installed packages (uses cache first)
 */
export async function getPackageDescriptions(
  packages: InstalledPackage[]
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>();
  const cache = await loadCache();

  for (const pkg of packages) {
    const npmSource = parseNpmSource(pkg.source);
    if (!npmSource?.name) continue;

    const cached = cache.packages.get(npmSource.name);
    const description = cached ? getFreshCachedField(cached, "description") : undefined;
    if (typeof description === "string") {
      descriptions.set(pkg.source, description);
    }
  }

  return descriptions;
}

/**
 * Get package size from cache
 */
export async function getCachedPackageSize(name: string): Promise<number | undefined> {
  const cache = await loadCache();
  const data = cache.packages.get(name);
  return data ? (getFreshCachedField(data, "size") as number | undefined) : undefined;
}

/**
 * Set package size in cache
 */
export async function setCachedPackageSize(name: string, size: number): Promise<void> {
  const cache = await loadCache();
  const existing = cache.packages.get(name);

  const timestamp = Date.now();

  if (existing) {
    existing.timestamp = timestamp;
    setCachedPackageField(existing, "size", size, timestamp);
  } else {
    cache.packages.set(name, {
      name,
      size,
      timestamp,
      fieldTimestamps: {
        size: timestamp,
      },
    });
  }

  await enqueueCacheSave();
}
