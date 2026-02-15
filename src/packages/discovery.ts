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
import { getPackageSourceKind, splitGitRepoAndRef } from "../utils/package-source.js";

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

export async function searchNpmPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<NpmPackage[]> {
  // Pull more results so browse mode has meaningful pagination.
  // npm search can still cap server-side, but this improves coverage.
  const searchLimit = 250;

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

  const res = await pi.exec("npm", ["search", "--json", `--searchlimit=${searchLimit}`, query], {
    timeout: TIMEOUTS.npmSearch,
    cwd: ctx.cwd,
  });

  if (res.code !== 0) {
    throw new Error(`npm search failed: ${res.stderr || res.stdout || `exit ${res.code}`}`);
  }

  try {
    const parsed = JSON.parse(res.stdout || "[]") as NpmPackage[];
    const filtered = parsed.filter((p) => !!p?.name);

    // Cache the results
    await setCachedSearch(query, filtered);

    return filtered;
  } catch {
    throw new Error("Failed to parse npm search output");
  }
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

function normalizeSourceIdentity(source: string): string {
  return sanitizeListSourceSuffix(source).replace(/\\/g, "/").toLowerCase();
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

function parseInstalledPackagesOutputInternal(
  text: string,
  options?: { dedupeBySource?: boolean }
): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  const seenSources = new Set<string>();

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
    if (options?.dedupeBySource !== false) {
      const sourceIdentity = normalizeSourceIdentity(source);
      if (seenSources.has(sourceIdentity)) {
        currentPackage = undefined;
        continue;
      }
      seenSources.add(sourceIdentity);
    }

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

export function parseInstalledPackagesOutput(text: string): InstalledPackage[] {
  return parseInstalledPackagesOutputInternal(text, { dedupeBySource: true });
}

/**
 * Check if a specific source is installed by running `pi list` and checking output.
 * Returns true if found, false if not found.
 */
export async function isSourceInstalled(
  source: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<boolean> {
  try {
    const res = await pi.exec("pi", ["list"], { timeout: TIMEOUTS.listPackages, cwd: ctx.cwd });
    if (res.code !== 0) return false;

    const normalized = source.toLowerCase().replace(/\\/g, "/");
    const stdout = res.stdout || "";

    // Check if the source appears in the output (case-insensitive, normalized paths)
    return stdout.toLowerCase().replace(/\\/g, "/").includes(normalized);
  } catch {
    return false;
  }
}

export function parseInstalledPackagesOutputAllScopes(text: string): InstalledPackage[] {
  return parseInstalledPackagesOutputInternal(text, { dedupeBySource: false });
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
    const gitSpec = fullSource.startsWith("git:") ? fullSource.slice(4) : fullSource;
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
    const res = await pi.exec("npm", ["view", pkgName, "dist.unpackedSize", "--json"], {
      timeout: TIMEOUTS.npmView,
      cwd: ctx.cwd,
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
                  const res = await pi.exec("npm", ["view", pkgName, "description", "--json"], {
                    timeout: TIMEOUTS.npmView,
                    cwd: ctx.cwd,
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
