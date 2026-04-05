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
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyMatch,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { UI } from "../constants.js";
import {
  discoverExtensions,
  removeLocalExtension,
  setExtensionState,
} from "../extensions/discovery.js";
import { getInstalledPackages } from "../packages/discovery.js";
import {
  removePackageWithOutcome,
  showInstalledPackagesList,
  updatePackagesWithOutcome,
  updatePackageWithOutcome,
} from "../packages/management.js";
import {
  type InstalledPackage,
  type LocalUnifiedItem,
  type State,
  type UnifiedAction,
  type UnifiedItem,
} from "../types/index.js";
import { getKnownUpdates, promptAutoUpdateWizard } from "../utils/auto-update.js";
import { parseChoiceByLabel } from "../utils/command.js";
import { formatBytes, formatEntry as formatExtEntry } from "../utils/format.js";
import { logExtensionDelete, logExtensionToggle } from "../utils/history.js";
import { hasCustomUI, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { normalizePathIdentity } from "../utils/path-identity.js";
import { getPackageSourceKind, normalizePackageIdentity } from "../utils/package-source.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmReload, formatListOutput } from "../utils/ui-helpers.js";
import { runTaskWithLoader } from "./async-task.js";
import { buildFooterShortcuts, buildFooterState, getPendingToggleChangeCount } from "./footer.js";
import { showHelp } from "./help.js";
import { configurePackageExtensions } from "./package-config.js";
import { showRemote } from "./remote.js";
import { getChangeMarker, getPackageIcon, getScopeIcon, getStatusIcon } from "./theme.js";

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

      return { localEntries, installedPackages };
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

  const { localEntries, installedPackages } = initialData;

  // Build unified items list.
  const knownUpdates = getKnownUpdates(ctx);
  const items = buildUnifiedItems(localEntries, installedPackages, knownUpdates);

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

  const result = await runCustomUI(
    ctx,
    "The unified extensions manager",
    () =>
      ctx.ui.custom<UnifiedAction>((tui, theme, _keybindings, done) => {
        const container = new Container();

        const titleText = new Text("", 2, 0);
        const statsText = new Text("", 2, 0);
        const footerText = new Text("", 2, 0);
        const browser = new UnifiedManagerBrowser(
          items,
          staged,
          theme,
          ctx.cwd,
          Math.max(4, Math.min(UI.maxListHeight, tui.terminal.rows - 12)),
          done
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
            })
          );
          footerText.setText(
            theme.fg(
              "dim",
              buildFooterShortcuts(buildFooterState(staged, byId, browser.getSelectedItem()))
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

  return await handleUnifiedAction(result, items, staged, byId, ctx, pi);
}

export function buildUnifiedItems(
  localEntries: Awaited<ReturnType<typeof discoverExtensions>>,
  installedPackages: InstalledPackage[],
  knownUpdates: Set<string>
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  const localPaths = new Set<string>();

  // Add local extensions
  for (const entry of localEntries) {
    localPaths.add(normalizePathIdentity(entry.activePath));
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

    items.push({
      type: "package",
      id: `pkg:${pkg.source}`,
      displayName: pkg.name,
      scope: pkg.scope,
      source: pkg.source,
      version: pkg.version,
      description: pkg.description,
      size: pkg.size,
      updateAvailable: knownUpdates.has(normalizePackageIdentity(pkg.source)),
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

function buildManagerSummary(
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  theme: Theme,
  options?: {
    visibleItems?: readonly UnifiedItem[];
    filter?: UnifiedFilter;
    searchQuery?: string;
  }
): string {
  const summaryItems = options?.visibleItems ?? items;
  const filtered =
    Boolean(options?.searchQuery) ||
    options?.filter === "local" ||
    options?.filter === "packages" ||
    options?.filter === "updates" ||
    options?.filter === "disabled";
  const localCount = summaryItems.filter((item) => item.type === "local").length;
  const packageCount = summaryItems.length - localCount;
  const updateCount = summaryItems.filter(
    (item) => item.type === "package" && item.updateAvailable
  ).length;
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

  if (pendingCount > 0) {
    parts.push(theme.fg("warning", `${pendingCount} unsaved`));
  }

  return parts.join(" • ");
}

type UnifiedFilter = "all" | "local" | "packages" | "updates" | "disabled";

const UNIFIED_FILTER_OPTIONS: Array<{ id: UnifiedFilter; key: string; label: string }> = [
  { id: "all", key: "1", label: "All" },
  { id: "local", key: "2", label: "Local" },
  { id: "packages", key: "3", label: "Packages" },
  { id: "updates", key: "4", label: "Updates" },
  { id: "disabled", key: "5", label: "Disabled" },
];

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
  const scopeIcon = getScopeIcon(theme, item.scope);
  const name = theme.bold(item.displayName);
  const version = item.version ? theme.fg("dim", `@${item.version}`) : "";
  const size = item.size !== undefined ? theme.fg("dim", ` • ${formatBytes(item.size)}`) : "";
  const updateBadge = item.updateAvailable ? ` ${theme.fg("warning", "[update]")}` : "";

  return `${pkgIcon} [${scopeIcon}] ${name}${version}${size}${updateBadge}`;
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
  staged: Map<string, State>
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
      return item.type === "local" && getCurrentUnifiedItemState(item, staged) === "disabled";
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
    secondary: [item.version ?? "", item.description ?? ""],
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
  private _focused = false;

  constructor(
    private readonly items: UnifiedItem[],
    private readonly staged: Map<string, State>,
    private readonly theme: Theme,
    private readonly cwd: string,
    private readonly maxVisibleItems: number,
    private readonly onAction: (action: UnifiedAction) => void
  ) {
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

  invalidate(): void {
    this.searchInput.invalidate();
  }

  handleInput(data: string): void {
    this.handleManagerInput(data);
  }

  handleManagerInput(data: string): boolean {
    const kb = getKeybindings();

    if (this.searchActive) {
      if (matchesKey(data, Key.enter)) {
        this.searchActive = false;
        this.searchInput.focused = false;
        return true;
      }

      if (matchesKey(data, Key.escape)) {
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
      this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
      return true;
    }

    const selectedItem = this.getSelectedItem();
    const selectedId = selectedItem?.id;

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

    if (matchesKey(data, Key.enter) && selectedId) {
      this.onAction({ type: "action", itemId: selectedId, action: "menu" });
      return true;
    }

    if (data === "a" || data === "A") {
      if (selectedId) {
        this.onAction({ type: "action", itemId: selectedId, action: "menu" });
      }
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

    if (matchesKey(data, Key.escape)) {
      this.onAction({ type: "cancel" });
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    const searchQuery = this.searchInput.getValue().trim();
    if (this.searchActive) {
      lines.push(...this.searchInput.render(width));
      lines.push("");
    } else if (searchQuery) {
      lines.push(truncateToWidth(this.theme.fg("accent", `  Search: ${searchQuery}`), width, ""));
      lines.push("");
    }

    lines.push(truncateToWidth(this.buildFilterLine(), width, ""));
    lines.push("");

    if (this.filteredItems.length === 0) {
      lines.push(this.theme.fg("warning", "  No matching extensions or packages"));
      return lines;
    }

    const { startIndex, endIndex } = this.getVisibleRange();
    const visibleItems = this.filteredItems.slice(startIndex, endIndex);
    const localCount = this.filteredItems.filter((item) => item.type === "local").length;
    const packageCount = this.filteredItems.length - localCount;
    const visibleLocalItems = visibleItems.filter((item) => item.type === "local");
    const visiblePackageItems = visibleItems.filter((item) => item.type === "package");

    if (visibleLocalItems.length > 0) {
      lines.push(this.theme.fg("accent", `  Local extensions (${localCount})`));
      for (const item of visibleLocalItems) {
        lines.push(this.renderItemLine(item, width));
      }
      if (visiblePackageItems.length > 0) {
        lines.push("");
      }
    }

    if (visiblePackageItems.length > 0) {
      lines.push(this.theme.fg("accent", `  Installed packages (${packageCount})`));
      for (const item of visiblePackageItems) {
        lines.push(this.renderItemLine(item, width));
      }
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      lines.push("");
      lines.push(
        this.theme.fg(
          "dim",
          `  Showing ${startIndex + 1}-${endIndex} of ${this.filteredItems.length}`
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
      for (const line of wrapTextWithAnsi(detailText, width - 4)) {
        lines.push(this.theme.fg("dim", `  ${line}`));
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
    const prefix = this.getSelectedItem()?.id === item.id ? this.theme.fg("accent", "→ ") : "  ";
    return truncateToWidth(
      prefix + formatUnifiedItemLabel(item, state, this.theme, changed),
      width
    );
  }

  private refreshVisibleItems(preferredItemId?: string): void {
    const previousSelectedId = preferredItemId ?? this.getSelectedItem()?.id;
    const filteredByMode = this.items.filter((item) =>
      matchesUnifiedFilter(item, this.filter, this.staged)
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
  autoUpdate: "🔁 Auto-update settings",
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
  "auto-update": "Auto-update",
  help: "Help",
};

const LOCAL_ACTION_OPTIONS = {
  details: "View details",
  remove: "Remove local extension",
  back: "Back to manager",
} as const;

const PACKAGE_ACTION_OPTIONS = {
  configure: "Configure extensions",
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
  ctx.ui.notify(
    `Name: ${item.displayName}\nVersion: ${item.version || "unknown"}\nSource: ${item.source}\nScope: ${item.scope}${sizeStr}${item.description ? `\nDescription: ${item.description}` : ""}`,
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
): Promise<"done" | "stay" | "exit"> {
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
      return "done";
    case "search":
      await showRemote("search", ctx, pi);
      return "done";
    case "browse":
      await showRemote("", ctx, pi);
      return "done";
    case "update-all": {
      const outcome = await updatePackagesWithOutcome(ctx, pi);
      return outcome.reloaded ? "exit" : "done";
    }
    case "auto-update":
      await promptAutoUpdateWizard(pi, ctx, (packages) => {
        ctx.ui.notify(
          `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
          "info"
        );
      });
      void updateExtmgrStatus(ctx, pi);
      return "done";
    case "help":
      showHelp(ctx);
      return "done";
  }
}

async function handleUnifiedAction(
  result: UnifiedAction,
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  if (result.type === "cancel") {
    const pendingCount = getPendingToggleChangeCount(staged, byId);
    if (pendingCount > 0) {
      const choice = await ctx.ui.select(`Unsaved changes (${pendingCount})`, [
        "Save and exit",
        "Exit without saving",
        "Stay in manager",
      ]);

      if (!choice || choice === "Stay in manager") {
        return false;
      }

      if (choice === "Save and exit") {
        const apply = await applyToggleChangesFromManager(items, staged, ctx, pi);
        if (apply.reloaded) return true;
        if (apply.changed === 0 && apply.hasErrors) return false;
      }
    }

    return true;
  }

  if (result.type === "remote") {
    const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Remote");
    if (pending === "stay") return false;

    await showRemote("", ctx, pi);
    return false;
  }

  if (result.type === "help") {
    const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Help");
    if (pending === "stay") return false;

    showHelp(ctx);
    return false;
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
      return false;
    }

    const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
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
        return false;
      }

      if (selection === "details") {
        showUnifiedItemDetails(item, ctx, staged.get(item.id) ?? item.state);
        return false;
      }

      if (selection !== "remove") {
        return false;
      }

      const pending = await resolvePendingChangesBeforeLeave(
        items,
        staged,
        byId,
        ctx,
        pi,
        "remove extension"
      );
      if (pending === "stay") return false;

      const confirmed = await ctx.ui.confirm(
        "Delete Local Extension",
        `Delete ${item.displayName} from disk?\n\nThis cannot be undone.`
      );
      if (!confirmed) return false;

      const removal = await removeLocalExtension(
        { activePath: item.activePath, disabledPath: item.disabledPath },
        ctx.cwd
      );
      if (!removal.ok) {
        logExtensionDelete(pi, item.id, false, removal.error);
        ctx.ui.notify(`Failed to remove extension: ${removal.error}`, "error");
        return false;
      }

      logExtensionDelete(pi, item.id, true);
      ctx.ui.notify(
        `Removed ${item.displayName}${removal.removedDirectory ? " (directory)" : ""}.`,
        "info"
      );

      return await confirmReload(ctx, "Extension removed.");
    }

    const pkg: InstalledPackage = {
      source: item.source,
      name: item.displayName,
      ...(item.version ? { version: item.version } : {}),
      scope: item.scope,
      ...(item.description ? { description: item.description } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
    };

    const selection =
      !result.action || result.action === "menu"
        ? await promptPackageActionSelection(pkg, ctx)
        : result.action;

    if (selection === "cancel") {
      return false;
    }

    if (selection === "details") {
      showUnifiedItemDetails(item, ctx);
      return false;
    }

    const pendingDestinationBySelection = {
      configure: "configure package extensions",
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
    if (pending === "stay") return false;

    switch (selection) {
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
  return apply.reloaded;
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
