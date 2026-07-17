/**
 * Unified extension manager UI
 * Displays local extensions and installed packages in one view
 */
import { homedir } from "node:os";
import { relative } from "node:path";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyMatch,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { UI } from "../constants.js";
import {
  discoverExtensions,
  removeLocalExtension,
  setExtensionState,
} from "../extensions/discovery.js";
import { undoExtensionTrash } from "../extensions/trash.js";
import { getPackageCatalog } from "../packages/catalog.js";
import { getInstalledPackages, getInstalledPackagesAllScopes } from "../packages/discovery.js";
import {
  applyPackageExtensionStateChanges,
  discoverPackageExtensions,
} from "../packages/extensions.js";
import {
  removePackageWithOutcome,
  showInstalledPackagesList,
  updatePackagesWithOutcome,
  updatePackageWithOutcome,
} from "../packages/management.js";
import {
  type InstalledPackage,
  type LocalUnifiedItem,
  type PackageExtensionEntry,
  type PackageExtensionStateSummary,
  type State,
  type UnifiedAction,
  type UnifiedItem,
} from "../types/index.js";
import { getKnownUpdates, promptAutoUpdateWizard } from "../utils/auto-update.js";
import { parseChoiceByLabel } from "../utils/command.js";
import { formatBytes, formatEntry as formatExtEntry } from "../utils/format.js";
import {
  formatChangeEntry,
  logExtensionDelete,
  logExtensionToggle,
  queryPackageTimeline,
} from "../utils/history.js";
import { hasCustomUI, isProjectTrusted, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { getPackageSourceKind, normalizePackageIdentity } from "../utils/package-source.js";
import { normalizePathIdentity } from "../utils/path-identity.js";
import { comparePackageScopes, movePackageBetweenScopes } from "../packages/scopes.js";
import { markReloadRequired, readReloadState } from "../utils/reload-state.js";
import {
  getSavedViewsPath,
  type SavedView,
  readSavedViews,
  writeSavedViews,
} from "../utils/views.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmReload, formatListOutput } from "../utils/ui-helpers.js";
import { runTaskWithLoader } from "./async-task.js";
import { buildFooterShortcuts, buildFooterState, getPendingToggleChangeCount } from "./footer.js";
import { showHelp } from "./help.js";
import { configurePackageExtensions } from "./package-config.js";
import { showRemote } from "./remote.js";
import { getChangeMarker, getPackageIcon, getScopeIcon, getStatusIcon } from "./theme.js";

let lastReloadNoticeAt: number | undefined;

async function showInteractiveFallback(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await showListOnly(ctx);
  await showInstalledPackagesList(ctx, pi);
}

export async function showInteractive(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!hasCustomUI(ctx)) {
    notify(
      ctx,
      "The unified extensions manager requires the full interactive TUI. Showing read-only local and installed package lists instead.",
      "warning"
    );
    await showInteractiveFallback(ctx, pi);
    return;
  }

  const reloadState = await readReloadState();
  if (reloadState.required && reloadState.changedAt !== lastReloadNoticeAt) {
    lastReloadNoticeAt = reloadState.changedAt;
    notify(
      ctx,
      `Reload required for pending changes${reloadState.reasons.length > 0 ? `: ${reloadState.reasons.join(", ")}` : "."}`,
      "warning"
    );
  }

  // Main loop - keeps showing the menu until user explicitly exits
  while (true) {
    const shouldExit = await showInteractiveOnce(ctx, pi);
    if (shouldExit) break;
  }
}

async function showInteractiveOnce(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  const initialData = await runTaskWithLoader(
    ctx,
    {
      title: "Extensions Manager",
      message: "Loading extensions and packages...",
    },
    async ({ signal, setMessage }) => {
      const localEntriesPromise = discoverExtensions(ctx.cwd);
      const installedPackagesPromise = getInstalledPackages(
        ctx,
        pi,
        (current, total) => {
          if (total <= 0) {
            return;
          }
          setMessage(`Loading package metadata... ${current}/${total}`);
        },
        signal
      );

      const [localEntries, installedPackages] = await Promise.all([
        localEntriesPromise,
        installedPackagesPromise,
      ]);

      setMessage("Loading package extension states...");
      const packageExtensions = await discoverPackageExtensions(installedPackages, ctx.cwd, {
        projectTrusted: isProjectTrusted(ctx),
      });

      return { localEntries, installedPackages, packageExtensions };
    }
  );

  if (!initialData) {
    notify(
      ctx,
      "The unified extensions manager requires the full interactive TUI. Showing read-only local and installed package lists instead.",
      "warning"
    );
    await showInteractiveFallback(ctx, pi);
    return true;
  }

  const { localEntries, installedPackages, packageExtensions } = initialData;
  const viewsPath = getSavedViewsPath(ctx.cwd);
  let savedViews = await readSavedViews(viewsPath);

  // Build unified items list.
  const knownUpdates = getKnownUpdates(ctx);
  const items = buildUnifiedItems(localEntries, installedPackages, knownUpdates, packageExtensions);

  // If nothing found, show quick actions
  if (items.length === 0) {
    const choice = await ctx.ui.select("No extensions or packages found", [
      "Browse community packages",
      "Cancel",
    ]);

    if (choice === "Browse community packages") {
      await showRemote("", ctx, pi);
      return false;
    }
    return true;
  }

  // Staged changes tracking for local extensions.
  const staged = new Map<string, State>();
  const byId = new Map(items.map((item) => [item.id, item]));
  let managerState = viewToManagerState(savedViews.lastView);

  while (true) {
    let nextManagerState = managerState;

    const result = await runCustomUI(
      ctx,
      "The unified extensions manager",
      () =>
        ctx.ui.custom<UnifiedAction>((tui, theme, keybindings, done) => {
          const container = new Container();

          const titleText = new Text("", 2, 0);
          const statsText = new Text("", 2, 0);
          const footerText = new Text("", 2, 0);
          let browser!: UnifiedManagerBrowser;
          const complete = (action: UnifiedAction): void => {
            nextManagerState = browser.getViewState();
            done(action);
          };
          browser = new UnifiedManagerBrowser(
            items,
            staged,
            theme,
            keybindings,
            ctx.cwd,
            Math.max(4, Math.min(UI.maxListHeight, tui.terminal.rows - 12)),
            complete,
            new Set(savedViews.favorites),
            new Set(savedViews.recent),
            managerState
          );
          let lastWidth = tui.terminal.columns;

          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(titleText);
          container.addChild(statsText);
          container.addChild(new Spacer(1));
          container.addChild(browser);
          container.addChild(new Spacer(1));
          container.addChild(footerText);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          const syncThemedContent = (width = lastWidth): void => {
            lastWidth = width;
            titleText.setText(theme.fg("accent", theme.bold("Extensions Manager")));
            statsText.setText(
              buildManagerSummary(items, staged, byId, theme, {
                visibleItems: browser.getVisibleItems(),
                filter: browser.getFilter(),
                searchQuery: browser.getSearchQuery(),
                selectedCount: browser.getBulkSelectedCount(),
              })
            );
            footerText.setText(
              theme.fg(
                "dim",
                buildFooterShortcuts(
                  buildFooterState(
                    staged,
                    byId,
                    browser.getSelectedItem(),
                    browser.getBulkSelectedCount()
                  ),
                  keybindings
                )
              )
            );
          };

          syncThemedContent();

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
              syncThemedContent(width);
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
              browser.invalidate();
              syncThemedContent(lastWidth);
            },
            handleInput(data: string) {
              if (browser.handleManagerInput(data)) {
                tui.requestRender();
              }
            },
          };
        }),
      "Showing read-only local and installed package lists instead."
    );

    if (!result) {
      await showInteractiveFallback(ctx, pi);
      return true;
    }

    if (nextManagerState) {
      const lastView = managerStateToView(
        nextManagerState,
        "last-used",
        savedViews.lastView?.createdAt
      );
      const selectedItemId = nextManagerState.selectedItemId;
      const recent = selectedItemId
        ? [selectedItemId, ...savedViews.recent.filter((id) => id !== selectedItemId)].slice(0, 20)
        : savedViews.recent;
      savedViews = { ...savedViews, lastView, recent };
      await writeSavedViews(viewsPath, savedViews);
    }

    const outcome = await handleUnifiedAction(
      result,
      items,
      staged,
      byId,
      ctx,
      pi,
      savedViews,
      viewsPath,
      nextManagerState
    );
    if (outcome === "resume") {
      managerState = viewToManagerState(savedViews.lastView) ?? nextManagerState;
      continue;
    }

    return outcome;
  }
}

export function buildUnifiedItems(
  localEntries: Awaited<ReturnType<typeof discoverExtensions>>,
  installedPackages: InstalledPackage[],
  knownUpdates: Set<string>,
  packageExtensions: PackageExtensionEntry[] = []
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  const localPaths = new Set<string>();
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
      displayName: entry.displayName,
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
      id: `pkg:${pkg.source}`,
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

function getPackageExtensionSummaryKey(scope: string, source: string): string {
  return `${scope}\0${source}`;
}

function buildPackageExtensionSummaries(
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

function getPackageExtensionStatusIcon(
  theme: Theme,
  summary?: PackageExtensionStateSummary
): string {
  if (!summary || summary.total === 0) return "";
  if (summary.disabled === 0) return getStatusIcon(theme, "enabled");
  if (summary.enabled === 0) return getStatusIcon(theme, "disabled");
  return theme.fg("warning", "◐");
}

function formatPackageExtensionState(summary?: PackageExtensionStateSummary): string | undefined {
  if (!summary || summary.total === 0) return undefined;
  if (summary.disabled === 0) {
    return `${summary.enabled}/${summary.total} package extensions enabled`;
  }
  if (summary.enabled === 0) {
    return `all ${summary.total} package extension${summary.total === 1 ? "" : "s"} disabled`;
  }
  return `${summary.enabled}/${summary.total} package extensions enabled (${summary.disabled} disabled)`;
}

function buildManagerSummary(
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  theme: Theme,
  options?: {
    visibleItems?: readonly UnifiedItem[];
    filter?: UnifiedFilter;
    searchQuery?: string;
    selectedCount?: number;
  }
): string {
  const summaryItems = options?.visibleItems ?? items;
  const filtered =
    Boolean(options?.searchQuery) ||
    options?.filter === "local" ||
    options?.filter === "packages" ||
    options?.filter === "updates" ||
    options?.filter === "disabled" ||
    options?.filter === "favorites" ||
    options?.filter === "recent";
  const localCount = summaryItems.filter((item) => item.type === "local").length;
  const packageCount = summaryItems.length - localCount;
  const updateCount = summaryItems.filter(
    (item) => item.type === "package" && item.updateAvailable
  ).length;
  const disabledCount = summaryItems.filter((item) => {
    if (item.type === "local") {
      return getCurrentUnifiedItemState(item, staged) === "disabled";
    }
    return (item.extensionSummary?.disabled ?? 0) > 0;
  }).length;
  const pendingCount = getPendingToggleChangeCount(staged, byId);
  const parts = [
    filtered
      ? theme.fg("accent", `showing ${summaryItems.length} of ${items.length}`)
      : theme.fg("muted", `${items.length} item${items.length === 1 ? "" : "s"}`),
    theme.fg("muted", `${localCount} local`),
  ];

  if (packageCount > 0) {
    parts.push(theme.fg("muted", `${packageCount} package${packageCount === 1 ? "" : "s"}`));
  }

  if (updateCount > 0) {
    parts.push(theme.fg("warning", `${updateCount} update${updateCount === 1 ? "" : "s"}`));
  }

  if (disabledCount > 0) {
    parts.push(theme.fg("warning", `${disabledCount} disabled`));
  }

  if (pendingCount > 0) {
    parts.push(theme.fg("warning", `${pendingCount} unsaved`));
  }

  if (packageCount > 0) {
    parts.push(theme.fg("muted", "Space selects packages"));
  }

  if ((options?.selectedCount ?? 0) > 0) {
    parts.push(theme.fg("accent", `${options?.selectedCount} selected · B to act`));
  }

  return parts.join(" • ");
}

type UnifiedFilter = "all" | "local" | "packages" | "updates" | "disabled" | "favorites" | "recent";

interface UnifiedManagerViewState {
  filter: UnifiedFilter;
  searchQuery: string;
  selectedItemId?: string;
  selectedItemIds: string[];
}

const UNIFIED_FILTER_OPTIONS: Array<{ id: UnifiedFilter; key: string; label: string }> = [
  { id: "all", key: "1", label: "All" },
  { id: "local", key: "2", label: "Local" },
  { id: "packages", key: "3", label: "Packages" },
  { id: "updates", key: "4", label: "Updates" },
  { id: "disabled", key: "5", label: "Disabled" },
  { id: "favorites", key: "6", label: "Favorites" },
  { id: "recent", key: "7", label: "Recent" },
];

function isUnifiedFilter(value: string): value is UnifiedFilter {
  return UNIFIED_FILTER_OPTIONS.some((option) => option.id === value);
}

function viewToManagerState(view: SavedView | undefined): UnifiedManagerViewState | undefined {
  if (!view || !isUnifiedFilter(view.filter)) return undefined;
  return {
    filter: view.filter,
    searchQuery: view.searchQuery,
    ...(view.selectedItemId ? { selectedItemId: view.selectedItemId } : {}),
    selectedItemIds: [...(view.selectedItemIds ?? [])],
  };
}

function managerStateToView(
  state: UnifiedManagerViewState,
  name: string,
  now = Date.now()
): SavedView {
  return {
    name,
    filter: state.filter,
    searchQuery: state.searchQuery,
    ...(state.selectedItemId ? { selectedItemId: state.selectedItemId } : {}),
    selectedItemIds: [...state.selectedItemIds],
    createdAt: now,
    updatedAt: now,
  };
}

function getCurrentUnifiedItemState(
  item: UnifiedItem,
  staged: Map<string, State>
): State | undefined {
  return item.type === "local" ? (staged.get(item.id) ?? item.state) : undefined;
}

function formatUnifiedItemLabel(
  item: UnifiedItem,
  state: State | undefined,
  theme: Theme,
  changed = false
): string {
  if (item.type === "local") {
    const statusIcon = getStatusIcon(theme, state ?? item.state);
    const scopeIcon = getScopeIcon(theme, item.scope);
    const changeMarker = getChangeMarker(theme, changed);
    const name = theme.bold(item.displayName);
    return `${statusIcon} [${scopeIcon}] ${name}${changeMarker}`;
  }

  const sourceKind = getPackageSourceKind(item.source);
  const pkgIcon = getPackageIcon(
    theme,
    sourceKind === "npm" || sourceKind === "git" || sourceKind === "local" ? sourceKind : "local"
  );
  const extensionStatusIcon = getPackageExtensionStatusIcon(theme, item.extensionSummary);
  const extensionStatusPrefix = extensionStatusIcon ? `${extensionStatusIcon} ` : "";
  const scopeIcon = getScopeIcon(theme, item.scope);
  const name = theme.bold(item.displayName);
  const version = item.version ? theme.fg("dim", `@${item.version}`) : "";
  const size = item.size !== undefined ? theme.fg("dim", ` • ${formatBytes(item.size)}`) : "";
  const updateBadge = item.updateAvailable ? ` ${theme.fg("warning", "[update]")}` : "";

  return `${extensionStatusPrefix}${pkgIcon} [${scopeIcon}] ${name}${version}${size}${updateBadge}`;
}

function getLocalItemCurrentPath(item: LocalUnifiedItem, state?: State): string {
  return (state ?? item.state) === "enabled" ? item.activePath : item.disabledPath;
}

function formatUnifiedItemDescription(
  item: UnifiedItem,
  state: State | undefined,
  changed: boolean,
  cwd: string
): string {
  if (item.type === "local") {
    const details = [
      item.summary,
      "local extension",
      item.scope,
      changed ? `staged → ${state ?? item.state}` : (state ?? item.state),
      compactDisplayPath(getLocalItemCurrentPath(item, state), cwd),
    ];

    return details.filter(Boolean).join(" • ");
  }

  const sourceKind = getPackageSourceKind(item.source);
  const source = sourceKind === "local" ? compactDisplayPath(item.source, cwd) : item.source;
  const details = [
    item.description || "No description",
    `${sourceKind === "unknown" ? "package" : `${sourceKind} package`}`,
    formatPackageExtensionState(item.extensionSummary),
    item.scope,
    source,
    item.updateAvailable ? "update available" : undefined,
    item.size !== undefined ? formatBytes(item.size) : undefined,
  ];

  return details.filter(Boolean).join(" • ");
}

function compactDisplayPath(filePath: string, cwd: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedHome = homedir().replace(/\\/g, "/");

  if (normalizedPath === normalizedHome) {
    return "~";
  }

  if (normalizedPath.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedPath.slice(normalizedHome.length + 1)}`;
  }

  const relativePath = relative(cwd, filePath).replace(/\\/g, "/");
  if (
    relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !isAbsoluteDisplayPath(relativePath)
  ) {
    return `./${relativePath}`;
  }

  return normalizedPath;
}

function isAbsoluteDisplayPath(value: string): boolean {
  return /^([a-zA-Z]:\/|\/|\\\\)/.test(value);
}

function matchesUnifiedFilter(
  item: UnifiedItem,
  filter: UnifiedFilter,
  staged: Map<string, State>,
  favoriteIds: ReadonlySet<string>,
  recentIds: ReadonlySet<string>
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "local":
      return item.type === "local";
    case "packages":
      return item.type === "package";
    case "updates":
      return item.type === "package" && Boolean(item.updateAvailable);
    case "disabled":
      if (item.type === "local") {
        return getCurrentUnifiedItemState(item, staged) === "disabled";
      }
      return (item.extensionSummary?.disabled ?? 0) > 0;
    case "favorites":
      return favoriteIds.has(item.id);
    case "recent":
      return recentIds.has(item.id);
  }
}

function getUnifiedItemSearchFields(
  item: UnifiedItem,
  staged: Map<string, State>,
  cwd: string
): { primary: string[]; secondary: string[] } {
  if (item.type === "local") {
    const state = getCurrentUnifiedItemState(item, staged) ?? item.state;
    return {
      primary: [item.displayName, compactDisplayPath(getLocalItemCurrentPath(item, state), cwd)],
      secondary: [item.summary],
    };
  }

  const source =
    getPackageSourceKind(item.source) === "local"
      ? compactDisplayPath(item.source, cwd)
      : item.source;
  return {
    primary: [item.displayName, source],
    secondary: [
      item.version ?? "",
      item.description ?? "",
      formatPackageExtensionState(item.extensionSummary) ?? "",
      item.extensionSummary
        ? item.extensionSummary.disabled > 0
          ? item.extensionSummary.enabled > 0
            ? "mixed disabled"
            : "disabled"
          : "enabled"
        : "",
    ],
  };
}

function scoreUnifiedItemSearchMatch(
  item: UnifiedItem,
  query: string,
  staged: Map<string, State>,
  cwd: string
): number | undefined {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return 0;
  }

  const fields = getUnifiedItemSearchFields(item, staged, cwd);
  const primary = fields.primary
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const secondary = fields.secondary
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  let totalScore = 0;

  for (const token of tokens) {
    const primarySubstringScore = primary.reduce<number | undefined>((best, field) => {
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

    const secondarySubstringScore = secondary.reduce<number | undefined>((best, field) => {
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

    const primaryFuzzyScore = primary.reduce<number | undefined>((best, field) => {
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

function searchUnifiedItems(
  items: UnifiedItem[],
  query: string,
  staged: Map<string, State>,
  cwd: string
): UnifiedItem[] {
  const matches = items
    .map((item, index) => ({
      item,
      index,
      score: scoreUnifiedItemSearchMatch(item, query, staged, cwd),
    }))
    .filter(
      (match): match is { item: UnifiedItem; index: number; score: number } =>
        match.score !== undefined
    );

  matches.sort((a, b) => a.score - b.score || a.index - b.index);
  return matches.map((match) => match.item);
}

class UnifiedManagerBrowser implements Focusable {
  private readonly searchInput = new Input();
  private readonly filteredItems: UnifiedItem[] = [];
  private selectedIndex = 0;
  private filter: UnifiedFilter = "all";
  private searchActive = false;
  private readonly expandedPackageIds = new Set<string>();
  private readonly bulkSelectedIds = new Set<string>();
  private _focused = false;

  constructor(
    private readonly items: UnifiedItem[],
    private readonly staged: Map<string, State>,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly cwd: string,
    private readonly maxVisibleItems: number,
    private readonly onAction: (action: UnifiedAction) => void,
    private readonly favoriteIds: ReadonlySet<string> = new Set(),
    private readonly recentIds: ReadonlySet<string> = new Set(),
    initialState?: UnifiedManagerViewState
  ) {
    if (initialState) {
      for (const id of initialState.selectedItemIds) {
        if (this.items.some((item) => item.id === id && item.type === "package")) {
          this.bulkSelectedIds.add(id);
        }
      }
      this.filter = initialState.filter;
      this.searchInput.setValue(initialState.searchQuery);
      this.refreshVisibleItems(initialState.selectedItemId);
      return;
    }

    this.refreshVisibleItems();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchActive;
  }

  getSelectedItem(): UnifiedItem | undefined {
    return this.filteredItems[this.selectedIndex];
  }

  getVisibleItems(): readonly UnifiedItem[] {
    return this.filteredItems;
  }

  getFilter(): UnifiedFilter {
    return this.filter;
  }

  getSearchQuery(): string {
    return this.searchInput.getValue().trim();
  }

  getBulkSelectedCount(): number {
    return this.bulkSelectedIds.size;
  }

  getViewState(): UnifiedManagerViewState {
    const selectedItemId = this.getSelectedItem()?.id;
    return {
      filter: this.filter,
      searchQuery: this.getSearchQuery(),
      ...(selectedItemId ? { selectedItemId } : {}),
      selectedItemIds: [...this.bulkSelectedIds],
    };
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  handleInput(data: string): void {
    this.handleManagerInput(data);
  }

  handleManagerInput(data: string): boolean {
    if (this.searchActive) {
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.searchActive = false;
        this.searchInput.focused = false;
        return true;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.searchInput.setValue("");
        this.searchActive = false;
        this.searchInput.focused = false;
        this.refreshVisibleItems();
        return true;
      }

      this.searchInput.handleInput(data);
      this.refreshVisibleItems();
      return true;
    }

    if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
      this.searchActive = true;
      this.searchInput.focused = this._focused;
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.cancel") && this.getSearchQuery()) {
      this.searchInput.setValue("");
      this.refreshVisibleItems();
      return true;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.cycleFilter(-1);
      return true;
    }

    if (matchesKey(data, Key.tab)) {
      this.cycleFilter(1);
      return true;
    }

    const directFilter = UNIFIED_FILTER_OPTIONS.find((option) => option.key === data)?.id;
    if (directFilter) {
      this.setFilter(directFilter);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-Math.max(1, this.maxVisibleItems - 1));
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(Math.max(1, this.maxVisibleItems - 1));
      return true;
    }

    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      return true;
    }

    if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
      return true;
    }

    const selectedItem = this.getSelectedItem();
    const selectedId = selectedItem?.id;

    if (data === " " && selectedItem?.type === "package") {
      if (this.bulkSelectedIds.has(selectedItem.id)) this.bulkSelectedIds.delete(selectedItem.id);
      else this.bulkSelectedIds.add(selectedItem.id);
      return true;
    }

    if (data === "B" && this.bulkSelectedIds.size > 0) {
      this.onAction({
        type: "bulk",
        itemIds: [...this.bulkSelectedIds],
        action: "menu",
      });
      return true;
    }

    if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
      this.onAction({ type: "apply" });
      return true;
    }

    if ((matchesKey(data, Key.space) || data === " ") && selectedItem?.type === "local") {
      const currentState =
        getCurrentUnifiedItemState(selectedItem, this.staged) ?? selectedItem.state;
      const nextState: State = currentState === "enabled" ? "disabled" : "enabled";
      if (nextState === selectedItem.originalState) {
        this.staged.delete(selectedItem.id);
      } else {
        this.staged.set(selectedItem.id, nextState);
      }
      this.refreshVisibleItems(selectedItem.id);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") && selectedId) {
      this.onAction({ type: "action", itemId: selectedId, action: "menu" });
      return true;
    }

    if (data === "a" || data === "A") {
      if (selectedId) {
        this.onAction({ type: "action", itemId: selectedId, action: "menu" });
      }
      return true;
    }

    if (data === "W") {
      this.onAction({ type: "views", action: "save" });
      return true;
    }

    if (data === "L") {
      this.onAction({ type: "views", action: "load" });
      return true;
    }

    if (data === "D") {
      this.onAction({ type: "views", action: "delete" });
      return true;
    }

    if (data === "*" && selectedId) {
      this.onAction({ type: "views", action: "favorite", itemId: selectedId });
      return true;
    }

    if (data === "i") {
      this.onAction({ type: "quick", action: "install" });
      return true;
    }

    if (data === "f") {
      this.onAction({ type: "quick", action: "search" });
      return true;
    }

    if (data === "U") {
      this.onAction({ type: "quick", action: "update-all" });
      return true;
    }

    if (data === "t" || data === "T") {
      this.onAction({ type: "quick", action: "auto-update" });
      return true;
    }

    if (selectedId && (data === "v" || data === "V")) {
      this.onAction({ type: "action", itemId: selectedId, action: "details" });
      return true;
    }

    if (selectedId && selectedItem?.type === "package") {
      if (data === "e" || data === "E") {
        if (selectedItem.extensionPaths?.length) {
          if (this.expandedPackageIds.has(selectedId)) this.expandedPackageIds.delete(selectedId);
          else this.expandedPackageIds.add(selectedId);
        }
        return true;
      }
      if (data === "u") {
        this.onAction({ type: "action", itemId: selectedId, action: "update" });
        return true;
      }
      if (data === "x" || data === "X") {
        this.onAction({ type: "action", itemId: selectedId, action: "remove" });
        return true;
      }
      if (data === "c" || data === "C") {
        this.onAction({ type: "action", itemId: selectedId, action: "configure" });
        return true;
      }
    }

    if (selectedId && selectedItem?.type === "local" && (data === "x" || data === "X")) {
      this.onAction({ type: "action", itemId: selectedId, action: "remove" });
      return true;
    }

    if (data === "r" || data === "R") {
      this.onAction({ type: "remote" });
      return true;
    }

    if (data === "?" || data === "h" || data === "H") {
      this.onAction({ type: "help" });
      return true;
    }

    if (data === "m" || data === "M" || data === "p" || data === "P") {
      this.onAction({ type: "menu" });
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onAction({ type: "cancel" });
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];

    const searchQuery = this.searchInput.getValue().trim();
    if (this.searchActive) {
      lines.push(...this.searchInput.render(safeWidth));
      lines.push("");
    } else if (searchQuery) {
      lines.push(
        truncateToWidth(this.theme.fg("accent", `  Search: ${searchQuery}`), safeWidth, "")
      );
      lines.push("");
    }

    lines.push(truncateToWidth(this.buildFilterLine(), safeWidth, ""));
    lines.push("");

    if (this.filteredItems.length === 0) {
      const emptyMessage = searchQuery
        ? `  No items match “${searchQuery}”. Try clearing search with Esc.`
        : this.filter === "favorites"
          ? "  No favorites yet. Press * on an item to favorite it."
          : this.filter === "recent"
            ? "  No recent items yet. Open an item to build your recent list."
            : this.filter === "updates"
              ? "  No updates are currently known."
              : this.filter === "disabled"
                ? "  No disabled extensions or package entrypoints."
                : "  No extensions or packages installed yet. Press i to install one.";
      lines.push(truncateToWidth(this.theme.fg("warning", emptyMessage), safeWidth, ""));
      return lines;
    }

    const { startIndex, endIndex } = this.getVisibleRange();
    const visibleItems = this.filteredItems.slice(startIndex, endIndex);
    const localCount = this.filteredItems.filter((item) => item.type === "local").length;
    const packageCount = this.filteredItems.length - localCount;
    const visibleLocalItems = visibleItems.filter((item) => item.type === "local");
    const visiblePackageItems = visibleItems.filter((item) => item.type === "package");

    if (visibleLocalItems.length > 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("accent", `  Local extensions (${localCount})`),
          safeWidth,
          ""
        )
      );
      for (const item of visibleLocalItems) {
        lines.push(this.renderItemLine(item, safeWidth));
      }
      if (visiblePackageItems.length > 0) {
        lines.push("");
      }
    }

    if (visiblePackageItems.length > 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("accent", `  Installed packages (${packageCount})`),
          safeWidth,
          ""
        )
      );
      for (const item of visiblePackageItems) {
        lines.push(this.renderItemLine(item, safeWidth));
        if (this.expandedPackageIds.has(item.id) && item.extensionPaths?.length) {
          for (const extensionPath of item.extensionPaths) {
            lines.push(
              truncateToWidth(this.theme.fg("dim", `    ↳ ${extensionPath}`), safeWidth, "")
            );
          }
        }
      }
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      lines.push("");
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(
            `  Showing ${startIndex + 1}-${endIndex} of ${this.filteredItems.length}`,
            safeWidth,
            ""
          )
        )
      );
    }

    const selectedItem = this.getSelectedItem();
    if (selectedItem) {
      lines.push("");
      const selectedState = getCurrentUnifiedItemState(selectedItem, this.staged);
      const detailText = formatUnifiedItemDescription(
        selectedItem,
        selectedState,
        selectedItem.type === "local" && selectedState !== selectedItem.originalState,
        this.cwd
      );
      for (const line of wrapTextWithAnsi(detailText, Math.max(1, safeWidth - 4))) {
        lines.push(truncateToWidth(this.theme.fg("dim", `  ${line}`), safeWidth, ""));
      }
    }

    return lines;
  }

  private buildFilterLine(): string {
    const filters = UNIFIED_FILTER_OPTIONS.map(({ id, key, label }) => {
      const text = `${key}:${label}`;
      return id === this.filter
        ? this.theme.fg("accent", `[${text}]`)
        : this.theme.fg("muted", text);
    }).join(" ");
    const searchHint = this.theme.fg(
      this.searchActive || this.searchInput.getValue() ? "accent" : "dim",
      "/ search"
    );
    return `  ${filters} · ${searchHint}`;
  }

  private renderItemLine(item: UnifiedItem, width: number): string {
    const state = getCurrentUnifiedItemState(item, this.staged);
    const changed = item.type === "local" && state !== item.originalState;
    const selectionMarker =
      item.type === "package" && this.bulkSelectedIds.has(item.id)
        ? this.theme.fg("accent", "[x] ")
        : item.type === "package"
          ? "[ ] "
          : "";
    const prefix = this.getSelectedItem()?.id === item.id ? this.theme.fg("accent", "→ ") : "  ";
    return truncateToWidth(
      prefix + selectionMarker + formatUnifiedItemLabel(item, state, this.theme, changed),
      width
    );
  }

  private refreshVisibleItems(preferredItemId?: string): void {
    const previousSelectedId = preferredItemId ?? this.getSelectedItem()?.id;
    const filteredByMode = this.items.filter((item) =>
      matchesUnifiedFilter(item, this.filter, this.staged, this.favoriteIds, this.recentIds)
    );
    const query = this.searchInput.getValue().trim();
    this.filteredItems.length = 0;
    this.filteredItems.push(
      ...(query ? searchUnifiedItems(filteredByMode, query, this.staged, this.cwd) : filteredByMode)
    );

    if (this.filteredItems.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    const nextSelectedIndex = previousSelectedId
      ? this.filteredItems.findIndex((item) => item.id === previousSelectedId)
      : -1;
    if (nextSelectedIndex >= 0) {
      this.selectedIndex = nextSelectedIndex;
      return;
    }

    this.selectedIndex = Math.min(this.selectedIndex, this.filteredItems.length - 1);
  }

  private setFilter(filter: UnifiedFilter): void {
    this.filter = filter;
    this.refreshVisibleItems();
  }

  private cycleFilter(direction: -1 | 1): void {
    const currentIndex = UNIFIED_FILTER_OPTIONS.findIndex((option) => option.id === this.filter);
    const nextIndex =
      (currentIndex + direction + UNIFIED_FILTER_OPTIONS.length) % UNIFIED_FILTER_OPTIONS.length;
    const nextFilter = UNIFIED_FILTER_OPTIONS[nextIndex]?.id;
    if (nextFilter) {
      this.setFilter(nextFilter);
    }
  }

  private moveSelection(delta: number): void {
    if (this.filteredItems.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    const nextIndex = this.selectedIndex + delta;
    if (nextIndex < 0) {
      this.selectedIndex = 0;
      return;
    }

    if (nextIndex >= this.filteredItems.length) {
      this.selectedIndex = this.filteredItems.length - 1;
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
        Math.max(0, this.filteredItems.length - maxVisible)
      )
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);
    return { startIndex, endIndex };
  }
}

function getToggleItemsForApply(items: UnifiedItem[]): LocalUnifiedItem[] {
  return items.filter((item): item is LocalUnifiedItem => item.type === "local");
}

async function applyToggleChangesFromManager(
  items: UnifiedItem[],
  staged: Map<string, State>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: { promptReload?: boolean }
): Promise<{ changed: number; reloaded: boolean; hasErrors: boolean }> {
  const toggleItems = getToggleItemsForApply(items);
  const apply = await applyStagedChanges(toggleItems, staged, pi);

  if (apply.errors.length > 0) {
    ctx.ui.notify(
      `Applied ${apply.changed} change(s), ${apply.errors.length} failed.\n${apply.errors.join("\n")}`,
      "warning"
    );
  } else if (apply.changed === 0) {
    ctx.ui.notify("No changes to apply.", "info");
  } else {
    ctx.ui.notify(`Applied ${apply.changed} local extension change(s).`, "info");
  }

  if (apply.changed > 0) {
    const shouldPromptReload = options?.promptReload ?? true;

    if (shouldPromptReload) {
      const reloaded = await confirmReload(ctx, "Local extensions changed.");
      return { changed: apply.changed, reloaded, hasErrors: apply.errors.length > 0 };
    }

    await markReloadRequired("Local extensions changed.");
    ctx.ui.notify("Changes saved. Reload pi later to fully apply extension state updates.", "info");
  }

  return { changed: apply.changed, reloaded: false, hasErrors: apply.errors.length > 0 };
}

async function resolvePendingChangesBeforeLeave(
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  destinationLabel: string
): Promise<"continue" | "stay"> {
  const pendingCount = getPendingToggleChangeCount(staged, byId);
  if (pendingCount === 0) return "continue";

  const choice = await ctx.ui.select(`Unsaved changes (${pendingCount})`, [
    `Save and continue to ${destinationLabel}`,
    "Discard changes",
    "Stay in manager",
  ]);

  if (!choice || choice === "Stay in manager") {
    return "stay";
  }

  if (choice === "Discard changes") {
    staged.clear();
    return "continue";
  }

  const apply = await applyToggleChangesFromManager(items, staged, ctx, pi, {
    promptReload: false,
  });
  return apply.changed === 0 && apply.hasErrors ? "stay" : "continue";
}

const PALETTE_OPTIONS = {
  install: "📥 Install package",
  search: "🔎 Search packages",
  browse: "🌐 Browse community packages",
  updateAll: "⬆️ Update all packages",
  autoUpdate: "🔁 Scheduled update checks settings",
  help: "❓ Help",
  back: "Back",
} as const;

type PaletteAction = keyof typeof PALETTE_OPTIONS;

type QuickDestination = "install" | "search" | "browse" | "update-all" | "auto-update" | "help";

const QUICK_DESTINATION_LABELS: Record<QuickDestination, string> = {
  install: "Install",
  search: "Search",
  browse: "Remote",
  "update-all": "Update",
  "auto-update": "Scheduled update checks",
  help: "Help",
};

const LOCAL_ACTION_OPTIONS = {
  details: "View details",
  remove: "Remove local extension",
  back: "Back to manager",
} as const;

const BULK_ACTION_OPTIONS = {
  update: "Update selected packages",
  remove: "Remove selected packages",
  enable: "Enable selected package extensions",
  disable: "Disable selected package extensions",
  cancel: "Cancel",
} as const;

const PACKAGE_ACTION_OPTIONS = {
  configure: "Configure extensions",
  enable: "Enable whole package",
  disable: "Disable whole package",
  compare: "Compare scopes",
  "move-global": "Move to global scope",
  "move-project": "Move to project scope",
  update: "Update package",
  remove: "Remove package",
  details: "View details",
  back: "Back to manager",
} as const;

type LocalActionKey = keyof typeof LOCAL_ACTION_OPTIONS;
type PackageActionKey = keyof typeof PACKAGE_ACTION_OPTIONS;

type LocalActionSelection = Exclude<LocalActionKey, "back"> | "cancel";
type PackageActionSelection = Exclude<PackageActionKey, "back"> | "cancel";

async function promptLocalActionSelection(
  item: LocalUnifiedItem,
  ctx: ExtensionCommandContext
): Promise<LocalActionSelection> {
  const selection = parseChoiceByLabel(
    LOCAL_ACTION_OPTIONS,
    await ctx.ui.select(item.displayName, Object.values(LOCAL_ACTION_OPTIONS))
  );

  if (!selection || selection === "back") {
    return "cancel";
  }

  return selection;
}

async function promptPackageActionSelection(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext
): Promise<PackageActionSelection> {
  const selection = parseChoiceByLabel(
    PACKAGE_ACTION_OPTIONS,
    await ctx.ui.select(pkg.name, Object.values(PACKAGE_ACTION_OPTIONS))
  );

  if (!selection || selection === "back") {
    return "cancel";
  }

  return selection;
}

function showUnifiedItemDetails(
  item: UnifiedItem,
  ctx: ExtensionCommandContext,
  state?: State
): void {
  if (item.type === "local") {
    const currentState = state ?? item.state;
    ctx.ui.notify(
      `Name: ${item.displayName}\nScope: ${item.scope}\nState: ${currentState}\nPath: ${getLocalItemCurrentPath(item, currentState)}\nSummary: ${item.summary}`,
      "info"
    );
    return;
  }

  const sizeStr = item.size !== undefined ? `\nSize: ${formatBytes(item.size)}` : "";
  const extensionState = formatPackageExtensionState(item.extensionSummary);
  const extensionStr = extensionState ? `\nExtensions: ${extensionState}` : "";
  const timeline = queryPackageTimeline(ctx, item.source, { limit: 5 });
  const timelineText =
    timeline.length > 0
      ? `\nRecent activity:\n${timeline.map((entry) => `- ${formatChangeEntry(entry)}`).join("\n")}`
      : "\nRecent activity: none in this session";
  ctx.ui.notify(
    `Name: ${item.displayName}\nVersion: ${item.version || "unknown"}\nSource: ${item.source}\nScope: ${item.scope}${extensionStr}${sizeStr}${item.description ? `\nDescription: ${item.description}` : ""}${timelineText}`,
    "info"
  );
}

async function navigateWithPendingGuard(
  destination: QuickDestination,
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<"reload" | "resume" | "stay" | "exit"> {
  const pending = await resolvePendingChangesBeforeLeave(
    items,
    staged,
    byId,
    ctx,
    pi,
    QUICK_DESTINATION_LABELS[destination]
  );
  if (pending === "stay") return "stay";

  switch (destination) {
    case "install":
      await showRemote("install", ctx, pi);
      return "reload";
    case "search":
      await showRemote("search", ctx, pi);
      return "reload";
    case "browse":
      await showRemote("", ctx, pi);
      return "reload";
    case "update-all": {
      const outcome = await updatePackagesWithOutcome(ctx, pi);
      return outcome.reloaded ? "exit" : "reload";
    }
    case "auto-update":
      await promptAutoUpdateWizard(pi, ctx, (packages) => {
        ctx.ui.notify(
          `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
          "info"
        );
      });
      void updateExtmgrStatus(ctx, pi);
      return "resume";
    case "help":
      showHelp(ctx);
      return "resume";
  }
}

async function handleUnifiedAction(
  result: UnifiedAction,
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  savedViews: Awaited<ReturnType<typeof readSavedViews>>,
  viewsPath: string,
  currentViewState?: UnifiedManagerViewState
): Promise<boolean | "resume"> {
  if (result.type === "cancel") {
    const pendingCount = getPendingToggleChangeCount(staged, byId);
    if (pendingCount > 0) {
      const choice = await ctx.ui.select(`Unsaved changes (${pendingCount})`, [
        "Save and exit",
        "Exit without saving",
        "Stay in manager",
      ]);

      if (!choice || choice === "Stay in manager") {
        return "resume";
      }

      if (choice === "Save and exit") {
        const apply = await applyToggleChangesFromManager(items, staged, ctx, pi);
        if (apply.reloaded) return true;
        if (apply.changed === 0 && apply.hasErrors) return "resume";
      }
    }

    return true;
  }

  if (result.type === "views") {
    if (result.action === "favorite") {
      const itemId = result.itemId;
      if (!itemId) return "resume";
      const favorites = new Set(savedViews.favorites);
      if (favorites.has(itemId)) {
        favorites.delete(itemId);
        notify(ctx, "Removed from favorites.", "info");
      } else {
        favorites.add(itemId);
        notify(ctx, "Added to favorites.", "info");
      }
      savedViews.favorites = [...favorites];
      await writeSavedViews(viewsPath, savedViews);
      return "resume";
    }

    if (result.action === "save") {
      if (!currentViewState) return "resume";
      const name = (await ctx.ui.input("Save manager view", "name"))?.trim();
      if (!name) return "resume";
      const existing = savedViews.views.find((view) => view.name === name);
      if (existing && !(await ctx.ui.confirm("Overwrite view", `Replace saved view “${name}”?`))) {
        return "resume";
      }
      const now = Date.now();
      const saved = managerStateToView(currentViewState, name, existing?.createdAt ?? now);
      savedViews.views = existing
        ? savedViews.views.map((view) => (view.name === name ? saved : view))
        : [...savedViews.views, saved];
      await writeSavedViews(viewsPath, savedViews);
      notify(ctx, `Saved view “${name}”.`, "info");
      return "resume";
    }

    if (result.action === "load") {
      if (savedViews.views.length === 0) {
        notify(ctx, "No saved views yet. Press W to save the current view.", "info");
        return "resume";
      }
      const choice = await ctx.ui.select(
        "Load manager view",
        savedViews.views.map((view) => view.name)
      );
      const selected = savedViews.views.find((view) => view.name === choice);
      if (selected) {
        savedViews.lastView = selected;
        await writeSavedViews(viewsPath, savedViews);
        notify(ctx, `Loaded view “${selected.name}”.`, "info");
      }
      return "resume";
    }

    if (savedViews.views.length === 0) {
      notify(ctx, "No saved views to delete.", "info");
      return "resume";
    }
    const choice = await ctx.ui.select(
      "Delete manager view",
      savedViews.views.map((view) => view.name)
    );
    if (choice && (await ctx.ui.confirm("Delete view", `Delete saved view “${choice}”?`))) {
      savedViews.views = savedViews.views.filter((view) => view.name !== choice);
      await writeSavedViews(viewsPath, savedViews);
      notify(ctx, `Deleted view “${choice}”.`, "info");
    }
    return "resume";
  }

  if (result.type === "bulk") {
    const selectedPackages = result.itemIds
      .map((id) => byId.get(id))
      .filter(
        (item): item is Extract<UnifiedItem, { type: "package" }> => item?.type === "package"
      );
    if (selectedPackages.length === 0) return "resume";

    const action =
      result.action === "menu"
        ? parseChoiceByLabel(
            BULK_ACTION_OPTIONS,
            await ctx.ui.select(
              `${selectedPackages.length} selected packages`,
              Object.values(BULK_ACTION_OPTIONS)
            )
          )
        : result.action;
    if (!action || action === "cancel") return "resume";

    const confirmed = await ctx.ui.confirm(
      "Bulk package operation",
      `${BULK_ACTION_OPTIONS[action]} for ${selectedPackages.length} package(s)?`
    );
    if (!confirmed) return "resume";

    const results = await runTaskWithLoader(
      ctx,
      {
        title: "Bulk package operation",
        message: `${BULK_ACTION_OPTIONS[action]}...`,
        cancellable: false,
        fallbackWithoutLoader: true,
      },
      async ({ setMessage }) => {
        const catalog = getPackageCatalog(ctx.cwd, isProjectTrusted(ctx));
        const completed: string[] = [];
        const failed: string[] = [];
        const skipped: string[] = [];
        const availableUpdates =
          action === "update"
            ? new Set(
                (await catalog.checkForAvailableUpdates()).map(
                  (update) => `${update.scope}\0${normalizePackageIdentity(update.source)}`
                )
              )
            : undefined;
        for (const item of selectedPackages) {
          setMessage(`${BULK_ACTION_OPTIONS[action]}: ${item.displayName}...`);
          try {
            if (action === "update") {
              if (
                !availableUpdates?.has(`${item.scope}\0${normalizePackageIdentity(item.source)}`)
              ) {
                skipped.push(`${item.displayName}: already current or pinned`);
                continue;
              }
              await catalog.update(item.source, (event) => {
                if (event.message) setMessage(event.message);
              });
            } else if (action === "remove") {
              await catalog.remove(item.source, item.scope, (event) => {
                if (event.message) setMessage(event.message);
              });
            } else {
              if (!item.extensionPaths?.length) {
                throw new Error("no package extension entrypoints were discovered");
              }
              const target: State = action === "enable" ? "enabled" : "disabled";
              const changed = await applyPackageExtensionStateChanges(
                item.source,
                item.scope,
                item.extensionPaths.map((extensionPath) => ({ extensionPath, target })),
                ctx.cwd,
                isProjectTrusted(ctx)
              );
              if (!changed.ok) throw new Error(changed.error);
            }
            completed.push(item.displayName);
          } catch (error) {
            failed.push(
              `${item.displayName}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return { completed, failed, skipped };
      }
    );

    if (!results) return "resume";
    const summary = [
      `${results.completed.length} succeeded`,
      `${results.failed.length} failed`,
      `${results.skipped.length} skipped`,
      results.completed.length > 0
        ? "Reload required: confirm Reload Required to apply changes."
        : "Reload required: no",
      ...results.failed.map((failure) => `- ${failure}`),
      ...results.skipped.map((skipped) => `- ${skipped}`),
    ].join("\n");
    ctx.ui.notify(summary, results.failed.length > 0 ? "warning" : "info");
    if (results.completed.length === 0) return "resume";

    const reloaded = await confirmReload(ctx, "Bulk package changes completed.");
    return reloaded;
  }

  if (result.type === "remote") {
    const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Remote");
    if (pending === "stay") return "resume";

    await showRemote("", ctx, pi);
    return false;
  }

  if (result.type === "help") {
    const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Help");
    if (pending === "stay") return "resume";

    showHelp(ctx);
    return "resume";
  }

  if (result.type === "menu") {
    const choice = parseChoiceByLabel(
      PALETTE_OPTIONS,
      await ctx.ui.select("Quick Actions", Object.values(PALETTE_OPTIONS))
    );

    const destinationByAction: Partial<Record<PaletteAction, QuickDestination>> = {
      install: "install",
      search: "search",
      browse: "browse",
      updateAll: "update-all",
      autoUpdate: "auto-update",
      help: "help",
    };

    const destination = choice ? destinationByAction[choice] : undefined;
    if (!destination) {
      return "resume";
    }

    const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
    if (outcome === "stay" || outcome === "resume") return "resume";
    return outcome === "exit";
  }

  if (result.type === "quick") {
    const quickDestinationMap: Record<(typeof result)["action"], QuickDestination> = {
      install: "install",
      search: "search",
      "update-all": "update-all",
      "auto-update": "auto-update",
    };

    const destination = quickDestinationMap[result.action];
    const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
    if (outcome === "stay" || outcome === "resume") return "resume";
    return outcome === "exit";
  }

  if (result.type === "action") {
    const item = byId.get(result.itemId);
    if (!item) return false;

    if (item.type === "local") {
      const selection =
        !result.action || result.action === "menu"
          ? await promptLocalActionSelection(item, ctx)
          : result.action;

      if (selection === "cancel") {
        return "resume";
      }

      if (selection === "details") {
        showUnifiedItemDetails(item, ctx, staged.get(item.id) ?? item.state);
        return "resume";
      }

      if (selection !== "remove") {
        return "resume";
      }

      const pending = await resolvePendingChangesBeforeLeave(
        items,
        staged,
        byId,
        ctx,
        pi,
        "remove extension"
      );
      if (pending === "stay") return "resume";

      const confirmed = await ctx.ui.confirm(
        "Delete Local Extension",
        `Remove ${item.displayName} from disk?\n\nIt will be moved to trash, where you can restore it later.`
      );
      if (!confirmed) return "resume";

      const removal = await removeLocalExtension(
        { activePath: item.activePath, disabledPath: item.disabledPath },
        ctx.cwd
      );
      if (!removal.ok) {
        logExtensionDelete(pi, item.id, false, removal.error);
        ctx.ui.notify(`Failed to remove extension: ${removal.error}`, "error");
        return "resume";
      }

      logExtensionDelete(pi, item.id, true);
      ctx.ui.notify(
        `Moved ${item.displayName}${removal.removedDirectory ? " (directory)" : ""} to trash.`,
        "info"
      );
      const undo = await ctx.ui.confirm("Undo Removal", "Restore the extension from trash now?");
      if (undo) {
        try {
          await undoExtensionTrash(removal.trashRecord);
          ctx.ui.notify(`Restored ${item.displayName}.`, "info");
          return "resume";
        } catch (error) {
          ctx.ui.notify(
            `Undo failed: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
      }

      return await confirmReload(ctx, "Extension removed.");
    }

    const pkg: InstalledPackage = {
      source: item.source,
      name: item.displayName,
      ...(item.version ? { version: item.version } : {}),
      scope: item.scope,
      ...(item.resolvedPath ? { resolvedPath: item.resolvedPath } : {}),
      ...(item.description ? { description: item.description } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
    };

    const selection =
      !result.action || result.action === "menu"
        ? await promptPackageActionSelection(pkg, ctx)
        : result.action;

    if (selection === "cancel") {
      return "resume";
    }

    if (selection === "details") {
      showUnifiedItemDetails(item, ctx);
      return "resume";
    }

    const pendingDestinationBySelection = {
      configure: "configure package extensions",
      enable: "enable package",
      disable: "disable package",
      compare: "compare package scopes",
      "move-global": "move package to global scope",
      "move-project": "move package to project scope",
      update: "update package",
      remove: "remove package",
    } satisfies Record<Exclude<PackageActionSelection, "cancel" | "details">, string>;

    const pending = await resolvePendingChangesBeforeLeave(
      items,
      staged,
      byId,
      ctx,
      pi,
      pendingDestinationBySelection[selection]
    );
    if (pending === "stay") return "resume";

    switch (selection) {
      case "compare": {
        const comparisons = comparePackageScopes(await getInstalledPackagesAllScopes(ctx)).filter(
          (comparison) =>
            comparison.global?.source === item.source || comparison.project?.source === item.source
        );
        const comparison = comparisons[0];
        if (!comparison) {
          ctx.ui.notify("No package scope comparison is available.", "warning");
        } else {
          ctx.ui.notify(
            [
              `Package: ${comparison.name}`,
              `Global: ${comparison.global?.source ?? "not configured"}`,
              `Project: ${comparison.project?.source ?? "not configured"}`,
              `Status: ${comparison.status}`,
            ].join("\n"),
            "info"
          );
        }
        return "resume";
      }
      case "move-global":
      case "move-project": {
        const targetScope = selection === "move-global" ? "global" : "project";
        if (targetScope === item.scope) {
          ctx.ui.notify(`Package is already in ${targetScope} scope.`, "info");
          return "resume";
        }
        const confirmed = await ctx.ui.confirm(
          "Move package scope",
          `Move ${item.source} from ${item.scope} to ${targetScope}?`
        );
        if (!confirmed) return "resume";
        const moved = await movePackageBetweenScopes(
          item.source,
          item.scope,
          targetScope,
          ctx.cwd,
          isProjectTrusted(ctx)
        );
        if (!moved.moved) {
          ctx.ui.notify(
            `${moved.partial ? "Package scope move partially completed" : "Package scope move failed"}: ${moved.conflict ?? "unknown error"}`,
            moved.partial ? "warning" : "error"
          );
          return moved.partial
            ? await confirmReload(ctx, "Package scope move partially completed.")
            : "resume";
        }
        ctx.ui.notify(`Moved ${item.displayName} to ${targetScope} scope.`, "info");
        return await confirmReload(ctx, "Package scope changed.");
      }
      case "enable":
      case "disable": {
        if (!item.extensionPaths?.length) {
          ctx.ui.notify("No package extension entrypoints were discovered.", "warning");
          return "resume";
        }
        const target: State = selection === "enable" ? "enabled" : "disabled";
        const result = await applyPackageExtensionStateChanges(
          item.source,
          item.scope,
          item.extensionPaths.map((extensionPath) => ({ extensionPath, target })),
          ctx.cwd,
          isProjectTrusted(ctx)
        );
        if (!result.ok) {
          ctx.ui.notify(`Package toggle failed: ${result.error}`, "error");
          return "resume";
        }
        ctx.ui.notify(
          `${target === "enabled" ? "Enabled" : "Disabled"} ${item.displayName}.`,
          "info"
        );
        return await confirmReload(ctx, "Package extension state changed.");
      }
      case "configure": {
        const outcome = await configurePackageExtensions(pkg, ctx, pi);
        return outcome.reloaded;
      }
      case "update": {
        const outcome = await updatePackageWithOutcome(pkg.source, ctx, pi);
        return outcome.reloaded;
      }
      case "remove": {
        const outcome = await removePackageWithOutcome(pkg.source, ctx, pi);
        return outcome.reloaded;
      }
    }
  }

  const apply = await applyToggleChangesFromManager(items, staged, ctx, pi);
  return apply.reloaded ? true : "resume";
}

async function applyStagedChanges(
  items: LocalUnifiedItem[],
  staged: Map<string, State>,
  pi: ExtensionAPI
) {
  let changed = 0;
  const errors: string[] = [];

  for (const item of items) {
    const target = staged.get(item.id) ?? item.originalState;
    if (target === item.originalState) continue;

    const fromState = item.originalState;
    const result = await setExtensionState(
      { activePath: item.activePath, disabledPath: item.disabledPath },
      target
    );

    if (result.ok) {
      changed++;
      item.state = target;
      item.originalState = target;
      staged.delete(item.id);
      logExtensionToggle(pi, item.id, fromState, target, true);
    } else {
      errors.push(`${item.id}: ${result.error}`);
      logExtensionToggle(pi, item.id, fromState, target, false, result.error);
    }
  }

  return { changed, errors };
}

// Legacy redirect
export async function showInstalledPackagesLegacy(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!hasCustomUI(ctx)) {
    await showInstalledPackagesList(ctx, pi);
    return;
  }

  ctx.ui.notify(
    "📦 Use /extensions for the unified view.\nInstalled packages are now shown alongside local extensions.",
    "info"
  );
  await showInteractive(ctx, pi);
}

// List-only view for non-interactive mode
export async function showListOnly(ctx: ExtensionCommandContext): Promise<void> {
  const entries = await discoverExtensions(ctx.cwd);
  if (entries.length === 0) {
    notify(ctx, "No extensions found in ~/.pi/agent/extensions or .pi/extensions", "info");
    return;
  }

  formatListOutput(ctx, "Local extensions", entries.map(formatExtEntry));
}
