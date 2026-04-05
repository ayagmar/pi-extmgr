/**
 * Remote package browsing UI
 */
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyMatch,
  type Focusable,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { CACHE_LIMITS, PAGE_SIZE, TIMEOUTS, UI } from "../constants.js";
import {
  getSearchCache,
  isCacheValid,
  searchNpmPackages,
  setSearchCache,
} from "../packages/discovery.js";
import {
  installPackage,
  installPackageLocallyWithOutcome,
  installPackageWithOutcome,
} from "../packages/install.js";
import { type BrowseAction, type NpmPackage, type SearchCache } from "../types/index.js";
import { parseChoiceByLabel, splitCommandArgs } from "../utils/command.js";
import { formatBytes, normalizePackageSource, parseNpmSource, truncate } from "../utils/format.js";
import { requireCustomUI, runCustomUI } from "../utils/mode.js";
import { fetchWithTimeout } from "../utils/network.js";
import { notify } from "../utils/notify.js";
import { execNpm } from "../utils/npm-exec.js";
import { getPackageSourceKind } from "../utils/package-source.js";
import { runTaskWithLoader } from "./async-task.js";

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
const packageInfoCache = new PackageInfoCache(
  CACHE_LIMITS.packageInfoMaxSize,
  CACHE_LIMITS.packageInfoTTL
);

export function clearRemotePackageInfoCache(): void {
  packageInfoCache.clear();
  clearCommunityBrowseCache();
}

let communityBrowseCache: SearchCache | null = null;

function getCommunityBrowseCache(): SearchCache | null {
  if (!communityBrowseCache) {
    return null;
  }

  if (Date.now() - communityBrowseCache.timestamp >= CACHE_LIMITS.searchTTL) {
    communityBrowseCache = null;
    return null;
  }

  return communityBrowseCache;
}

function setCommunityBrowseCache(results: NpmPackage[]): void {
  communityBrowseCache = {
    query: COMMUNITY_BROWSE_QUERY,
    results,
    timestamp: Date.now(),
  };
}

function clearCommunityBrowseCache(): void {
  communityBrowseCache = null;
}

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

const COMMUNITY_BROWSE_QUERY = "keywords:pi-package";

type RemoteBrowseSource = "community" | "npm";

type RemoteBrowseQueryPlan =
  | {
      kind: "browse";
      rawQuery: typeof COMMUNITY_BROWSE_QUERY;
      searchQuery: typeof COMMUNITY_BROWSE_QUERY;
      displayQuery: "";
      title: "Community packages";
    }
  | {
      kind: "search";
      rawQuery: string;
      searchQuery: string;
      displayQuery: string;
      title: string;
      exactPackageName?: string;
    }
  | {
      kind: "unsupported";
      rawQuery: string;
      message: string;
    };

function findExactPackageLookup(query: string): string | undefined {
  if (!query || /\s/.test(query)) {
    return undefined;
  }

  const parsed = parseNpmSource(normalizePackageSource(query));
  if (!parsed?.name) {
    return undefined;
  }

  if (query.startsWith("npm:") || Boolean(parsed.version) || parsed.name.startsWith("@")) {
    return parsed.name.toLowerCase();
  }

  return undefined;
}

function buildUnsupportedSearchMessage(query: string, kind: "local" | "git"): string {
  const label = truncate(query, 60);
  const sourceLabel = kind === "local" ? "local path" : "git source";
  return `"${label}" looks like a ${sourceLabel}. Remote browse searches npm package names and keywords. Use Install by source instead.`;
}

function createRemoteBrowseQueryPlan(query: string): RemoteBrowseQueryPlan {
  const trimmed = query.trim();
  if (!trimmed || trimmed === COMMUNITY_BROWSE_QUERY) {
    return {
      kind: "browse",
      rawQuery: COMMUNITY_BROWSE_QUERY,
      searchQuery: COMMUNITY_BROWSE_QUERY,
      displayQuery: "",
      title: "Community packages",
    };
  }

  const sourceKind = getPackageSourceKind(trimmed);
  if (sourceKind === "local" || sourceKind === "git") {
    return {
      kind: "unsupported",
      rawQuery: trimmed,
      message: buildUnsupportedSearchMessage(trimmed, sourceKind),
    };
  }

  const exactPackageName = findExactPackageLookup(trimmed);
  return {
    kind: "search",
    rawQuery: trimmed,
    searchQuery: exactPackageName ?? trimmed,
    displayQuery: trimmed,
    title: "Remote packages",
    ...(exactPackageName ? { exactPackageName } : {}),
  };
}

function createCommunityBrowsePlan(
  query: string
): Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }> {
  const trimmed = query.trim();
  if (!trimmed || trimmed === COMMUNITY_BROWSE_QUERY) {
    return {
      kind: "browse",
      rawQuery: COMMUNITY_BROWSE_QUERY,
      searchQuery: COMMUNITY_BROWSE_QUERY,
      displayQuery: "",
      title: "Community packages",
    };
  }

  return {
    kind: "search",
    rawQuery: trimmed,
    searchQuery: COMMUNITY_BROWSE_QUERY,
    displayQuery: trimmed,
    title: "Community packages",
  };
}

function resolveRemoteBrowseSource(query: string, source?: RemoteBrowseSource): RemoteBrowseSource {
  if (source) {
    return source;
  }

  const trimmed = query.trim();
  return !trimmed || trimmed === COMMUNITY_BROWSE_QUERY ? "community" : "npm";
}

function getCommunitySearchFields(pkg: NpmPackage): {
  primary: string[];
  secondary: string[];
} {
  return {
    primary: [pkg.name, pkg.author ?? ""]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
    secondary: [pkg.description ?? "", ...(pkg.keywords ?? [])]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  };
}

function scoreCommunityBrowseResult(pkg: NpmPackage, query: string): number | undefined {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return 0;
  }

  const fields = getCommunitySearchFields(pkg);
  let totalScore = 0;

  for (const token of tokens) {
    const primarySubstringScore = fields.primary.reduce<number | undefined>((best, field) => {
      const index = field.indexOf(token);
      if (index < 0) {
        return best;
      }
      return best === undefined ? index : Math.min(best, index);
    }, undefined);
    if (primarySubstringScore !== undefined) {
      totalScore += primarySubstringScore;
      continue;
    }

    const secondarySubstringScore = fields.secondary.reduce<number | undefined>((best, field) => {
      const index = field.indexOf(token);
      if (index < 0) {
        return best;
      }
      const score = 100 + index;
      return best === undefined ? score : Math.min(best, score);
    }, undefined);
    if (secondarySubstringScore !== undefined) {
      totalScore += secondarySubstringScore;
      continue;
    }

    const primaryFuzzyScore = fields.primary.reduce<number | undefined>((best, field) => {
      const match = fuzzyMatch(token, field);
      if (!match.matches) {
        return best;
      }
      const score = 200 + match.score;
      return best === undefined ? score : Math.min(best, score);
    }, undefined);
    if (primaryFuzzyScore !== undefined) {
      totalScore += primaryFuzzyScore;
      continue;
    }

    return undefined;
  }

  return totalScore;
}

function filterCommunityBrowseResults(packages: NpmPackage[], query: string): NpmPackage[] {
  const matches = packages
    .map((pkg, index) => ({
      pkg,
      index,
      score: scoreCommunityBrowseResult(pkg, query),
    }))
    .filter(
      (match): match is { pkg: NpmPackage; index: number; score: number } =>
        match.score !== undefined
    );

  matches.sort((a, b) => a.score - b.score || a.index - b.index);
  return matches.map((match) => match.pkg);
}

function filterRemoteBrowseResults(
  plan: Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }>,
  packages: NpmPackage[]
): NpmPackage[] {
  if (plan.kind !== "search" || !plan.exactPackageName) {
    return packages;
  }

  return packages.filter((pkg) => pkg.name.toLowerCase() === plan.exactPackageName);
}

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

function formatCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return new Intl.NumberFormat().format(value);
}

async function fetchWeeklyDownloads(
  packageName: string,
  signal?: AbortSignal
): Promise<number | undefined> {
  try {
    const encoded = encodeURIComponent(packageName);
    const res = await fetchWithTimeout(
      `https://api.npmjs.org/downloads/point/last-week/${encoded}`,
      TIMEOUTS.weeklyDownloads,
      signal
    );

    if (!res.ok) return undefined;
    const data = (await res.json()) as NpmDownloadsPoint;
    return typeof data.downloads === "number" ? data.downloads : undefined;
  } catch (error) {
    if (signal?.aborted && error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return undefined;
  }
}

async function buildPackageInfoText(
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

  const [infoRes, weeklyDownloads] = await Promise.all([
    execNpm(pi, ["view", packageName, "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
      ...(signal ? { signal } : {}),
    }),
    fetchWeeklyDownloads(packageName, signal),
  ]);

  throwIfAborted(signal);

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

  throwIfAborted(signal);
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
      await browseRemotePackages(ctx, COMMUNITY_BROWSE_QUERY, pi);
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
      await browseRemotePackages(ctx, COMMUNITY_BROWSE_QUERY, pi);
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

function formatRemotePackageLabel(pkg: NpmPackage, theme: Theme): string {
  const name = theme.bold(pkg.name);
  const version = pkg.version ? theme.fg("dim", `@${pkg.version}`) : "";
  return `${name}${version}`;
}

function formatRemotePackageDetails(
  pkg: NpmPackage,
  selectedNumber: number,
  totalResults: number
): string {
  const parts = [
    pkg.description || "No description",
    pkg.author ? `by ${pkg.author}` : undefined,
    `result ${selectedNumber} of ${totalResults}`,
    pkg.keywords?.length ? `keywords: ${pkg.keywords.slice(0, 5).join(", ")}` : undefined,
    pkg.date ? `updated ${pkg.date.slice(0, 10)}` : undefined,
  ];

  return parts.filter(Boolean).join(" • ");
}

class RemotePackageBrowser implements Focusable {
  private readonly searchInput = new Input();
  private selectedIndex = 0;
  private searchActive = false;
  private _focused = false;

  constructor(
    private readonly packages: NpmPackage[],
    private readonly theme: Theme,
    private readonly browseSource: RemoteBrowseSource,
    private readonly queryLabel: string,
    private readonly totalResults: number,
    private readonly offset: number,
    private readonly maxVisibleItems: number,
    private readonly showPrevious: boolean,
    private readonly showLoadMore: boolean,
    private readonly onAction: (action: BrowseAction) => void
  ) {
    this.searchInput.setValue(queryLabel);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchActive;
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  handleBrowseInput(data: string): boolean {
    const kb = getKeybindings();

    if (this.searchActive) {
      if (matchesKey(data, Key.enter)) {
        this.searchActive = false;
        this.searchInput.focused = false;
        this.onAction({ type: "search", query: this.searchInput.getValue().trim() });
        return true;
      }

      if (matchesKey(data, Key.escape)) {
        this.searchActive = false;
        this.searchInput.focused = false;
        this.searchInput.setValue(this.queryLabel);
        return true;
      }

      this.searchInput.handleInput(data);
      return true;
    }

    if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
      this.searchActive = true;
      this.searchInput.setValue("");
      this.searchInput.focused = this._focused;
      return true;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return true;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return true;
    }

    if (kb.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-Math.max(1, this.maxVisibleItems - 1));
      return true;
    }

    if (kb.matches(data, "tui.select.pageDown")) {
      this.moveSelection(Math.max(1, this.maxVisibleItems - 1));
      return true;
    }

    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      return true;
    }

    if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.packages.length - 1);
      return true;
    }

    const selected = this.packages[this.selectedIndex];
    if (selected && matchesKey(data, Key.enter)) {
      this.onAction({ type: "package", name: selected.name });
      return true;
    }

    if ((data === "p" || data === "P") && this.showPrevious) {
      this.onAction({ type: "prev" });
      return true;
    }

    if ((data === "n" || data === "N") && this.showLoadMore) {
      this.onAction({ type: "next" });
      return true;
    }

    if (data === "r" || data === "R") {
      this.onAction({ type: "refresh" });
      return true;
    }

    if (data === "i") {
      this.onAction({ type: "install" });
      return true;
    }

    if (data === "m" || data === "M") {
      this.onAction({ type: "menu" });
      return true;
    }

    if (matchesKey(data, Key.escape)) {
      this.onAction({ type: "cancel" });
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    if (this.searchActive) {
      lines.push(...this.searchInput.render(width));
      lines.push("");
    } else if (this.queryLabel) {
      lines.push(
        truncateToWidth(this.theme.fg("accent", `  Search: ${this.queryLabel}`), width, "")
      );
      lines.push("");
    } else {
      lines.push(
        this.theme.fg(
          "muted",
          this.browseSource === "community"
            ? "  Browse community packages · / search to filter loaded packages"
            : "  Browse remote search results · / search to search npm packages"
        )
      );
      lines.push("");
    }

    lines.push(truncateToWidth(this.buildSummaryLine(), width, ""));
    lines.push("");

    const { startIndex, endIndex } = this.getVisibleRange();
    for (const pkg of this.packages.slice(startIndex, endIndex)) {
      lines.push(this.renderPackageLine(pkg, width));
    }

    if (startIndex > 0 || endIndex < this.packages.length) {
      lines.push("");
      lines.push(
        this.theme.fg(
          "dim",
          `  Showing ${startIndex + 1}-${endIndex} of ${this.packages.length} on this page`
        )
      );
    }

    const selected = this.packages[this.selectedIndex];
    if (selected) {
      lines.push("");
      const detailText = formatRemotePackageDetails(
        selected,
        this.offset + this.selectedIndex + 1,
        this.totalResults
      );
      for (const line of wrapTextWithAnsi(detailText, width - 4)) {
        lines.push(this.theme.fg("dim", `  ${line}`));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(this.buildFooterLine(), width, ""));
    return lines;
  }

  private buildSummaryLine(): string {
    const pageCount = Math.max(1, Math.ceil(this.totalResults / PAGE_SIZE));
    const pageNumber = Math.floor(this.offset / PAGE_SIZE) + 1;
    const rangeEnd = this.offset + this.packages.length;
    const label = this.queryLabel
      ? `Search: ${truncate(this.queryLabel, 40)}`
      : "Community packages";
    return `  ${this.theme.fg("accent", label)} • ${this.theme.fg("muted", `${this.offset + 1}-${rangeEnd} of ${this.totalResults}`)} • ${this.theme.fg("muted", `page ${pageNumber}/${pageCount}`)}`;
  }

  private buildFooterLine(): string {
    const parts = ["Enter details", "/ search"];

    if (this.showPrevious) {
      parts.push("p prev");
    }
    if (this.showLoadMore) {
      parts.push("n next");
    }

    parts.push("r refresh", "i install", "m menu", "Esc back");
    return `  ${this.theme.fg("dim", parts.join(" · "))}`;
  }

  private renderPackageLine(pkg: NpmPackage, width: number): string {
    const prefix =
      this.packages[this.selectedIndex]?.name === pkg.name ? this.theme.fg("accent", "→ ") : "  ";
    return truncateToWidth(prefix + formatRemotePackageLabel(pkg, this.theme), width);
  }

  private moveSelection(delta: number): void {
    if (this.packages.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    const nextIndex = this.selectedIndex + delta;
    if (nextIndex < 0) {
      this.selectedIndex = 0;
      return;
    }

    if (nextIndex >= this.packages.length) {
      this.selectedIndex = this.packages.length - 1;
      return;
    }

    this.selectedIndex = nextIndex;
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const maxVisible = Math.max(1, this.maxVisibleItems);
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        Math.max(0, this.packages.length - maxVisible)
      )
    );
    const endIndex = Math.min(startIndex + maxVisible, this.packages.length);
    return { startIndex, endIndex };
  }
}

async function selectBrowseAction(
  ctx: ExtensionCommandContext,
  plan: Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }>,
  browseSource: RemoteBrowseSource,
  packages: NpmPackage[],
  offset: number,
  totalResults: number,
  showPrevious: boolean,
  showLoadMore: boolean
): Promise<BrowseAction | undefined> {
  if (!ctx.hasUI) return undefined;

  return runCustomUI(ctx, "Remote package browsing", () =>
    ctx.ui.custom<BrowseAction>((tui, theme, _keybindings, done) => {
      const container = new Container();
      const title = new Text("", 2, 0);
      const browser = new RemotePackageBrowser(
        packages,
        theme,
        browseSource,
        plan.displayQuery,
        totalResults,
        offset,
        Math.max(4, Math.min(UI.maxListHeight, tui.terminal.rows - 10)),
        showPrevious,
        showLoadMore,
        done
      );
      const syncThemedContent = (): void => {
        title.setText(theme.fg("accent", theme.bold(plan.title)));
      };

      syncThemedContent();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(title);
      container.addChild(new Spacer(1));
      container.addChild(browser);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      let focused = false;

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          browser.focused = value;
        },
        render(width: number) {
          syncThemedContent();
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
          browser.invalidate();
          syncThemedContent();
        },
        handleInput(data: string) {
          if (browser.handleBrowseInput(data)) {
            tui.requestRender();
          }
        },
      };
    })
  );
}

export async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0,
  source?: RemoteBrowseSource
): Promise<void> {
  if (
    !requireCustomUI(
      ctx,
      "Remote package browsing",
      "Use `/extensions install <source>` to install directly outside the full interactive TUI."
    )
  ) {
    return;
  }

  const browseSource = resolveRemoteBrowseSource(query, source);
  const plan =
    browseSource === "community"
      ? createCommunityBrowsePlan(query)
      : createRemoteBrowseQueryPlan(query);
  if (plan.kind === "unsupported") {
    notify(ctx, plan.message, "warning");
    return;
  }

  const cacheQuery = browseSource === "community" ? COMMUNITY_BROWSE_QUERY : plan.rawQuery;
  let allPackages: NpmPackage[] | undefined;

  if (browseSource === "community") {
    const cache = getCommunityBrowseCache();
    if (cache) {
      allPackages = filterCommunityBrowseResults(cache.results, plan.displayQuery);
    }
  }

  if (!allPackages && isCacheValid(cacheQuery)) {
    const cache = getSearchCache();
    if (cache?.query === cacheQuery) {
      allPackages =
        browseSource === "community"
          ? filterCommunityBrowseResults(cache.results, plan.displayQuery)
          : cache.results;
    }
  }

  if (!allPackages) {
    const searchLabel =
      browseSource === "community"
        ? "community packages"
        : plan.displayQuery || "community packages";
    const results = await runTaskWithLoader(
      ctx,
      {
        title: plan.title,
        message: `Searching npm for ${truncate(searchLabel, 40)}...`,
      },
      async ({ signal, setMessage }) => {
        setMessage(`Searching npm for ${truncate(searchLabel, 40)}...`);
        return searchNpmPackages(
          browseSource === "community" ? COMMUNITY_BROWSE_QUERY : plan.searchQuery,
          ctx,
          { signal }
        );
      }
    );

    if (!results) {
      notify(ctx, "Remote package search was cancelled.", "info");
      return;
    }

    if (browseSource === "community") {
      setCommunityBrowseCache(results);
      setSearchCache({
        query: COMMUNITY_BROWSE_QUERY,
        results,
        timestamp: Date.now(),
      });
      allPackages = filterCommunityBrowseResults(results, plan.displayQuery);
    } else {
      allPackages = filterRemoteBrowseResults(plan, results);
      setSearchCache({
        query: plan.rawQuery,
        results: allPackages,
        timestamp: Date.now(),
      });
    }
  }

  const totalResults = allPackages.length;
  const packages = allPackages.slice(offset, offset + PAGE_SIZE);
  const reloadQuery =
    browseSource === "community" ? plan.displayQuery || COMMUNITY_BROWSE_QUERY : plan.rawQuery;

  if (packages.length === 0) {
    const msg =
      offset > 0
        ? "No more packages to show."
        : `No packages found for: ${plan.displayQuery || "community packages"}`;
    ctx.ui.notify(msg, "info");

    if (offset > 0) {
      await browseRemotePackages(ctx, reloadQuery, pi, 0, browseSource);
    }
    return;
  }

  const showLoadMore = totalResults >= PAGE_SIZE && offset + PAGE_SIZE < totalResults;
  const showPrevious = offset > 0;

  const result = await selectBrowseAction(
    ctx,
    plan,
    browseSource,
    packages,
    offset,
    totalResults,
    showPrevious,
    showLoadMore
  );

  if (!result || result.type === "cancel") {
    return;
  }

  switch (result.type) {
    case "prev":
      await browseRemotePackages(
        ctx,
        reloadQuery,
        pi,
        Math.max(0, offset - PAGE_SIZE),
        browseSource
      );
      return;
    case "next":
      await browseRemotePackages(ctx, reloadQuery, pi, offset + PAGE_SIZE, browseSource);
      return;
    case "refresh":
      setSearchCache(null);
      if (browseSource === "community") {
        clearCommunityBrowseCache();
      }
      await browseRemotePackages(ctx, reloadQuery, pi, 0, browseSource);
      return;
    case "search": {
      const nextQuery = result.query.trim();
      if (browseSource === "community") {
        await browseRemotePackages(ctx, nextQuery || COMMUNITY_BROWSE_QUERY, pi, 0, "community");
        return;
      }
      await browseRemotePackages(
        ctx,
        nextQuery || COMMUNITY_BROWSE_QUERY,
        pi,
        0,
        nextQuery ? "npm" : undefined
      );
      return;
    }
    case "install":
      await promptInstall(ctx, pi);
      await browseRemotePackages(ctx, reloadQuery, pi, offset, browseSource);
      return;
    case "menu":
      await showRemoteMenu(ctx, pi);
      return;
    case "package":
      await showPackageDetails(result.name, ctx, pi, reloadQuery, offset, browseSource);
      return;
  }
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  previousQuery: string,
  previousOffset: number,
  browseSource?: RemoteBrowseSource
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
    case "installManaged": {
      const outcome = await installPackageWithOutcome(`npm:${packageName}`, ctx, pi);
      if (outcome.reloaded) {
        return;
      }
      if (outcome.installed) {
        await browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
        return;
      }
      await showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
      return;
    }
    case "installStandalone": {
      const outcome = await installPackageLocallyWithOutcome(packageName, ctx, pi);
      if (outcome.reloaded) {
        return;
      }
      if (outcome.installed) {
        await browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
        return;
      }
      await showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
      return;
    }
    case "viewInfo":
      try {
        const text = await runTaskWithLoader(
          ctx,
          {
            title: packageName,
            message: `Fetching package details for ${packageName}...`,
          },
          ({ signal }) => buildPackageInfoText(packageName, ctx, pi, signal)
        );

        if (!text) {
          notify(ctx, `Loading ${packageName} details was cancelled.`, "info");
          await showPackageDetails(
            packageName,
            ctx,
            pi,
            previousQuery,
            previousOffset,
            browseSource
          );
          return;
        }

        ctx.ui.notify(text, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Package: ${packageName}\n${message}`, "warning");
      }
      await showPackageDetails(packageName, ctx, pi, previousQuery, previousOffset, browseSource);
      return;
    case "back":
      await browseRemotePackages(ctx, previousQuery, pi, previousOffset, browseSource);
      return;
    default:
      return;
  }
}

async function promptSearch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const query = await ctx.ui.input("Search packages", "package name, keyword, or npm:@scope/pkg");
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
