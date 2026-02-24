/**
 * Remote package browsing UI
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import type { BrowseAction, NpmPackage } from "../types/index.js";
import { PAGE_SIZE, TIMEOUTS, CACHE_LIMITS } from "../constants.js";
import { truncate, dynamicTruncate, formatBytes } from "../utils/format.js";
import { parseChoiceByLabel, splitCommandArgs } from "../utils/command.js";
import {
  searchNpmPackages,
  getSearchCache,
  setSearchCache,
  isCacheValid,
} from "../packages/discovery.js";
import { installPackage, installPackageLocally } from "../packages/install.js";
import { execNpm } from "../utils/npm-exec.js";
import { notify } from "../utils/notify.js";

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
}

interface NpmDownloadsPoint {
  downloads?: number;
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
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
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

  get size(): number {
    return this.cache.size;
  }
}

// Global LRU cache instance
const packageInfoCache = new PackageInfoCache(
  CACHE_LIMITS.packageInfoMaxSize,
  CACHE_LIMITS.packageInfoTTL
);

const REMOTE_MENU_CHOICES = {
  browse: "🔍 Browse pi packages",
  search: "🔎 Search packages",
  install: "📥 Install by source",
} as const;

const PACKAGE_DETAILS_CHOICES = {
  installManaged: "Install via npm (managed)",
  installStandalone: "Install locally (standalone)",
  viewInfo: "View npm info",
  back: "Back to results",
} as const;

function formatCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return new Intl.NumberFormat().format(value);
}

async function fetchWeeklyDownloads(packageName: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.weeklyDownloads);

  try {
    const encoded = encodeURIComponent(packageName);
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encoded}`, {
      signal: controller.signal,
    });

    if (!res.ok) return undefined;
    const data = (await res.json()) as NpmDownloadsPoint;
    return typeof data.downloads === "number" ? data.downloads : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function buildPackageInfoText(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<string> {
  // Check cache first
  const cached = packageInfoCache.get(packageName);
  if (cached) {
    return cached.text;
  }

  const [infoRes, weeklyDownloads] = await Promise.all([
    execNpm(pi, ["view", packageName, "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
    }),
    fetchWeeklyDownloads(packageName),
  ]);

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

  const lines = [
    `${packageName}@${version}`,
    description,
    `Author: ${author}`,
    `Weekly downloads: ${formatCount(weeklyDownloads)}`,
    `Stars: ${formatCount(stars)}`,
    `Unpacked size: ${typeof unpackedSize === "number" ? formatBytes(unpackedSize) : "unknown"}`,
  ];

  if (homepage) lines.push(`Homepage: ${homepage}`);
  if (repository) lines.push(`Repository: ${repository}`);

  const text = lines.join("\n");

  // Store in LRU cache
  packageInfoCache.set(packageName, { text });

  return text;
}

export async function showRemote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const { subcommand: sub, args: rest } = splitCommandArgs(args);
  const query = rest.join(" ").trim();

  switch (sub) {
    case "list":
    case "installed":
      // Legacy: redirect to unified view
      ctx.ui.notify("📦 Use /extensions for the unified view.", "info");
      return;
    case "install":
      if (query) {
        await installPackage(query, ctx, pi);
      } else {
        await promptInstall(ctx, pi);
      }
      return;
    case "search":
      await searchPackages(query, ctx, pi);
      return;
    case "browse":
    case "":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      return;
  }

  // Show remote menu
  await showRemoteMenu(ctx, pi);
}

async function showRemoteMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;

  const choice = parseChoiceByLabel(
    REMOTE_MENU_CHOICES,
    await ctx.ui.select("Community Packages", Object.values(REMOTE_MENU_CHOICES))
  );

  switch (choice) {
    case "browse":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      return;
    case "search":
      await promptSearch(ctx, pi);
      return;
    case "install":
      await promptInstall(ctx, pi);
      return;
    default:
      return;
  }
}

async function selectBrowseAction(
  ctx: ExtensionCommandContext,
  titleText: string,
  packages: NpmPackage[],
  offset: number,
  totalResults: number,
  showPrevious: boolean,
  showLoadMore: boolean
): Promise<BrowseAction | undefined> {
  if (!ctx.hasUI) return undefined;

  const items: SelectItem[] = packages.map((p) => ({
    value: `pkg:${p.name}`,
    label: `${p.name}${p.version ? ` @${p.version}` : ""}`,
    description: dynamicTruncate(p.description || "No description", 35),
  }));

  if (showPrevious) {
    items.push({ value: "nav:prev", label: "◀  Previous page" });
  }
  if (showLoadMore) {
    items.push({
      value: "nav:next",
      label: `▶  Next page (${offset + 1}-${offset + packages.length} of ${totalResults})`,
    });
  }
  items.push({ value: "nav:refresh", label: "🔄 Refresh search" });
  items.push({ value: "nav:menu", label: "← Back to menu" });

  return ctx.ui.custom<BrowseAction | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(titleText)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      if (item.value === "nav:prev") {
        done({ type: "prev" });
      } else if (item.value === "nav:next") {
        done({ type: "next" });
      } else if (item.value === "nav:refresh") {
        done({ type: "refresh" });
      } else if (item.value === "nav:menu") {
        done({ type: "menu" });
      } else if (item.value.startsWith("pkg:")) {
        done({ type: "package", name: item.value.slice(4) });
      } else {
        done(undefined);
      }
    };

    selectList.onCancel = () => done(undefined);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ wraps • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0
): Promise<void> {
  // Check cache first
  let allPackages: NpmPackage[] = [];

  if (isCacheValid(query) && offset > 0) {
    const cache = getSearchCache();
    if (cache) allPackages = cache.results;
  } else {
    // Show searching notification
    ctx.ui.notify(`Searching npm for: ${truncate(query, 40)}...`, "info");

    // Perform search
    allPackages = await searchNpmPackages(query, ctx, pi);

    // Cache results for pagination
    setSearchCache({
      query,
      results: allPackages,
      timestamp: Date.now(),
    });
  }

  // Apply pagination from cached/filtered results
  const totalResults = allPackages.length;
  const packages = allPackages.slice(offset, offset + PAGE_SIZE);

  if (packages.length === 0) {
    const msg = offset > 0 ? "No more packages to show." : `No packages found for: ${query}`;
    ctx.ui.notify(msg, "info");

    if (offset > 0) {
      await browseRemotePackages(ctx, query, pi, 0);
    }
    return;
  }

  // Add navigation options
  const showLoadMore = totalResults >= PAGE_SIZE && offset + PAGE_SIZE < totalResults;
  const showPrevious = offset > 0;

  const titleText =
    offset > 0
      ? `Search Results (${offset + 1}-${offset + packages.length} of ${totalResults})`
      : `Search: ${truncate(query, 40)} (${totalResults})`;

  const result = await selectBrowseAction(
    ctx,
    titleText,
    packages,
    offset,
    totalResults,
    showPrevious,
    showLoadMore
  );

  if (!result) {
    return; // User cancelled
  }

  // Handle result
  switch (result.type) {
    case "prev":
      await browseRemotePackages(ctx, query, pi, Math.max(0, offset - PAGE_SIZE));
      return;
    case "next":
      await browseRemotePackages(ctx, query, pi, offset + PAGE_SIZE);
      return;
    case "refresh":
      setSearchCache(null);
      await browseRemotePackages(ctx, query, pi, 0);
      return;
    case "menu":
      await showRemoteMenu(ctx, pi);
      return;
    case "package":
      await showPackageDetails(result.name, ctx, pi, query, offset);
      return;
  }
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  previousQuery: string,
  previousOffset: number
): Promise<void> {
  if (!ctx.hasUI) {
    console.log(`Package: ${packageName}`);
    return;
  }

  const choice = parseChoiceByLabel(
    PACKAGE_DETAILS_CHOICES,
    await ctx.ui.select(packageName, Object.values(PACKAGE_DETAILS_CHOICES))
  );

  switch (choice) {
    case "installManaged":
      await installPackage(`npm:${packageName}`, ctx, pi);
      return;
    case "installStandalone":
      await installPackageLocally(packageName, ctx, pi);
      return;
    case "viewInfo":
      try {
        const text = await buildPackageInfoText(packageName, ctx, pi);
        ctx.ui.notify(text, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Package: ${packageName}\n${message}`, "warning");
      }
      await showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset);
      return;
    case "back":
      await browseRemotePackages(ctx, previousQuery, pi, previousOffset);
      return;
    default:
      return;
  }
}

async function promptSearch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const query = await ctx.ui.input("Search packages", "keywords:pi-package");
  if (!query?.trim()) return;
  await searchPackages(query.trim(), ctx, pi);
}

async function searchPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!query) {
    await promptSearch(ctx, pi);
    return;
  }
  await browseRemotePackages(ctx, query, pi);
}

async function promptInstall(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    notify(
      ctx,
      "Interactive input not available in non-interactive mode.\nUsage: /extensions install <npm:package|git:url|path>",
      "warning"
    );
    return;
  }
  const source = await ctx.ui.input("Install package", "npm:@scope/pkg or git:https://...");
  if (!source) return;
  await installPackage(source.trim(), ctx, pi);
}
