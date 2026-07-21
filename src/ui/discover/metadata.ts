/** Package metadata caching and retrieval for the Discover workspace. */
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CACHE_LIMITS, TIMEOUTS } from "../../constants.js";
import { fetchNpmWeeklyDownloads } from "../../packages/discovery.js";
import { inspectPackageMetadata } from "../../packages/inspection.js";
import { validateCompatibility } from "../../doctor/compatibility.js";
import { createAbortError, throwIfAborted } from "../../utils/abort.js";
import { formatBytes } from "../../utils/format.js";
import { execNpm } from "../../utils/npm-exec.js";
import { RequestGeneration } from "../async-task.js";

interface PackageInfoCacheEntry {
  timestamp: number;
  text: string;
}

interface NpmViewInfo {
  description?: string;
  version?: string;
  author?: { name?: string } | string;
  homepage?: string;
  users?: Record<string, boolean>;
  dist?: { unpackedSize?: number };
  repository?: { url?: string } | string;
  dependencies?: Record<string, string>;
  engines?: { node?: string; pi?: string };
}

// LRU Cache with size limit to prevent memory leaks
class PackageInfoCache {
  private cache = new Map<string, PackageInfoCacheEntry>();
  private readonly maxSize: number;
  private readonly ttl: number;

  constructor(maxSize: number, ttl: number) {
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(name: string): PackageInfoCacheEntry | undefined {
    const entry = this.cache.get(name);
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(name);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(name);
    this.cache.set(name, entry);
    return entry;
  }

  set(name: string, entry: Omit<PackageInfoCacheEntry, "timestamp">): void {
    if (this.cache.has(name)) {
      this.cache.delete(name);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(name, {
      ...entry,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Global LRU cache instance
export const packageInfoCache = new PackageInfoCache(
  CACHE_LIMITS.packageInfoMaxSize,
  CACHE_LIMITS.packageInfoTTL
);
const packageInfoRequests = new RequestGeneration();

export function clearRemotePackageInfoCache(): void {
  packageInfoRequests.cancel();
  packageInfoCache.clear();
}

export function formatCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return new Intl.NumberFormat().format(value);
}

async function fetchWeeklyDownloads(
  packageName: string,
  signal?: AbortSignal
): Promise<number | undefined> {
  return (await fetchNpmWeeklyDownloads([packageName], signal)).get(packageName);
}

export async function buildPackageInfoText(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  signal?: AbortSignal
): Promise<string> {
  // Check cache first
  const cached = packageInfoCache.get(packageName);
  if (cached) {
    return cached.text;
  }

  const request = packageInfoRequests.begin(signal);
  const [infoRes, weeklyDownloads] = await Promise.all([
    execNpm(pi, ["view", packageName, "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
      signal: request.signal,
    }),
    fetchWeeklyDownloads(packageName, request.signal),
  ]);

  throwIfAborted(request.signal);

  if (infoRes.code !== 0) {
    throw new Error(infoRes.stderr || infoRes.stdout || `npm view failed (exit ${infoRes.code})`);
  }

  const info = JSON.parse(infoRes.stdout) as NpmViewInfo;
  const description = info.description ?? "No description";
  const version = info.version ?? "unknown";
  const author = typeof info.author === "object" ? info.author?.name : (info.author ?? "unknown");
  const homepage = info.homepage ?? "";
  const stars = info.users ? Object.keys(info.users).length : undefined;
  const unpackedSize = info.dist?.unpackedSize;
  const repository = typeof info.repository === "string" ? info.repository : info.repository?.url;
  const compatibility =
    info.engines?.node || info.engines?.pi
      ? (() => {
          const diagnostic = validateCompatibility({
            packageName,
            ...(info.engines?.node ? { engines: { node: info.engines.node } } : {}),
            ...(info.engines?.pi ? { requiredPi: info.engines.pi } : {}),
            nodeVersion: process.version,
          });
          if (diagnostic.node === "incompatible" || diagnostic.pi === "incompatible") {
            return "incompatible" as const;
          }
          if (diagnostic.node === "unknown" || diagnostic.pi === "unknown") {
            return "unknown" as const;
          }
          return "compatible" as const;
        })()
      : undefined;
  const inspection = inspectPackageMetadata({
    name: packageName,
    ...(info.version ? { version: info.version } : {}),
    ...(info.description ? { description: info.description } : {}),
    ...(info.dependencies ? { dependencies: info.dependencies } : {}),
    ...(repository ? { repository } : {}),
    ...(compatibility ? { compatibility } : {}),
  });

  const lines = [
    `${packageName}@${version}`,
    description,
    `Author: ${author}`,
    `Weekly downloads: ${formatCount(weeklyDownloads)}`,
    `Stars: ${formatCount(stars)}`,
    `Unpacked size: ${typeof unpackedSize === "number" ? formatBytes(unpackedSize) : "unknown"}`,
    `Dependencies: ${inspection.dependencies.length > 0 ? inspection.dependencies.join(", ") : "none declared"}`,
    `Compatibility: ${inspection.compatibility}`,
    `Provenance: ${inspection.provenance}`,
  ];

  if (homepage) lines.push(`Homepage: ${homepage}`);
  if (repository) lines.push(`Repository: ${repository}`);

  const text = lines.join("\n");

  throwIfAborted(request.signal);
  if (!request.commit(() => packageInfoCache.set(packageName, { text }))) {
    throw createAbortError();
  }

  return text;
}
