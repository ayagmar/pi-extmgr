/** Interactive list browser component for the Installed workspace. */
import { type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type State, type UnifiedAction, type UnifiedItem } from "../../types/index.js";
import { formatBytes } from "../../utils/format.js";
import { getPackageSourceKind } from "../../utils/package-source.js";
import { composeColumns, TWO_PANE_MIN_WIDTH } from "../layout.js";
import { getCenteredVisibleRange, moveListSelection } from "../list-navigation.js";
import { getStatusIcon } from "../theme.js";
import { matchWorkspaceNavigation } from "../workspace/navigation.js";
import { matchesUnifiedFilter, searchUnifiedItems } from "./filters.js";
import {
  compactDisplayPath,
  formatPackageExtensionState,
  formatUnifiedItemDescription,
  formatUnifiedItemLabel,
} from "./formatting.js";
import { getCurrentUnifiedItemState, getLocalItemCurrentPath } from "./items.js";
import {
  UNIFIED_FILTER_OPTIONS,
  type UnifiedFilter,
  type UnifiedManagerViewState,
} from "./state.js";

export class UnifiedManagerBrowser implements Focusable {
  private readonly searchInput = new Input();
  private readonly filteredItems: UnifiedItem[] = [];
  private selectedIndex = 0;
  private filter: UnifiedFilter = "all";
  private searchActive = false;
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
    const workspaceScreen = matchWorkspaceNavigation(data, "installed");
    if (workspaceScreen) {
      this.onAction({ type: "workspace", screen: workspaceScreen });
      return true;
    }

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

    const directFilter = UNIFIED_FILTER_OPTIONS.find((option) => option.key === data)?.id;
    if (directFilter) {
      this.setFilter(directFilter);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1, true);
      return true;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1, true);
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

    const listLines: string[] = [];
    const { startIndex, endIndex } = this.getVisibleRange();
    const visibleItems = this.filteredItems.slice(startIndex, endIndex);
    const localCount = this.filteredItems.filter((item) => item.type === "local").length;
    const packageCount = this.filteredItems.length - localCount;
    const visibleLocalItems = visibleItems.filter((item) => item.type === "local");
    const visiblePackageItems = visibleItems.filter((item) => item.type === "package");

    if (visibleLocalItems.length > 0) {
      listLines.push(this.theme.fg("accent", `  Local extensions · ${localCount}`));
      for (const item of visibleLocalItems) {
        listLines.push(this.renderItemLine(item, safeWidth));
      }
      if (visiblePackageItems.length > 0) listLines.push("");
    }

    if (visiblePackageItems.length > 0) {
      listLines.push(this.theme.fg("accent", `  Packages · ${packageCount}`));
      for (const item of visiblePackageItems) {
        listLines.push(this.renderItemLine(item, safeWidth));
      }
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      listLines.push(
        "",
        this.theme.fg(
          "dim",
          `  Showing ${startIndex + 1}-${endIndex} of ${this.filteredItems.length}`
        )
      );
    }

    const selectedItem = this.getSelectedItem();
    if (selectedItem && safeWidth >= TWO_PANE_MIN_WIDTH) {
      const detailWidth = Math.max(1, Math.floor((safeWidth - 3) * 0.38));
      lines.push(
        ...composeColumns(
          listLines,
          this.renderInspector(selectedItem, detailWidth),
          safeWidth,
          this.theme.fg("borderMuted", " │ ")
        )
      );
    } else {
      lines.push(...listLines.map((line) => truncateToWidth(line, safeWidth, "")));
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
    }

    return lines;
  }

  private buildFilterLine(): string {
    const primaryFilterIds: UnifiedFilter[] = ["all", "local", "packages", "updates"];
    const visibleFilters = UNIFIED_FILTER_OPTIONS.filter(
      ({ id }) => primaryFilterIds.includes(id) || id === this.filter
    );
    const filters = visibleFilters
      .map(({ id, key, label }) =>
        id === this.filter
          ? this.theme.fg("accent", `[${key} ${label}]`)
          : this.theme.fg("muted", `${key} ${label}`)
      )
      .join("  ");
    const searchHint = this.theme.fg(
      this.searchActive || this.searchInput.getValue() ? "accent" : "dim",
      "/ Search"
    );
    return `  ${filters}    ${searchHint}`;
  }

  private renderInspector(item: UnifiedItem, width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const lines = [this.theme.fg("accent", this.theme.bold("Details")), ""];
    const pushDescription = (description: string): void => {
      for (const line of wrapTextWithAnsi(description, contentWidth)) lines.push(line);
    };

    if (item.type === "local") {
      const state = getCurrentUnifiedItemState(item, this.staged) ?? item.state;
      const changed = state !== item.originalState;
      lines.push(
        this.theme.bold(item.displayName),
        this.theme.fg("muted", `Local extension · ${item.scope}`),
        `${getStatusIcon(this.theme, state)} ${state}${changed ? this.theme.fg("warning", " · unsaved") : ""}`,
        ""
      );
      pushDescription(item.summary || "No description provided.");
      lines.push(
        "",
        this.theme.fg("dim", "Path"),
        compactDisplayPath(getLocalItemCurrentPath(item, state), this.cwd),
        "",
        this.theme.fg("dim", "Space toggle · Enter actions")
      );
    } else {
      const sourceKind = getPackageSourceKind(item.source);
      const extensionState = formatPackageExtensionState(item.extensionSummary);
      lines.push(
        this.theme.bold(item.displayName),
        this.theme.fg(
          "muted",
          `${sourceKind === "unknown" ? "Package" : sourceKind} package · ${item.scope}`
        ),
        item.version ? this.theme.fg("muted", `Version ${item.version}`) : "",
        ""
      );
      pushDescription(item.description || "No description provided.");
      lines.push("");
      if (extensionState) lines.push(`${this.theme.fg("dim", "Extensions")}  ${extensionState}`);
      if (item.size !== undefined)
        lines.push(`${this.theme.fg("dim", "Size")}        ${formatBytes(item.size)}`);
      if (item.updateAvailable) lines.push(this.theme.fg("warning", "Update available"));
      if (item.extensionPaths?.length) {
        lines.push("", this.theme.fg("dim", "Entrypoints"));
        for (const path of item.extensionPaths.slice(0, 4)) lines.push(path);
        if (item.extensionPaths.length > 4) {
          lines.push(this.theme.fg("dim", `+${item.extensionPaths.length - 4} more`));
        }
      }
      lines.push(
        "",
        this.theme.fg("dim", "Source"),
        item.source,
        "",
        this.theme.fg("dim", "Space select · Enter actions")
      );
    }

    return lines
      .filter((line, index, values) => line !== "" || values[index - 1] !== "")
      .map((line) => truncateToWidth(` ${line}`, width, ""));
  }

  private renderItemLine(item: UnifiedItem, width: number): string {
    const state = getCurrentUnifiedItemState(item, this.staged);
    const changed = item.type === "local" && state !== item.originalState;
    const selectedForBulk = item.type === "package" && this.bulkSelectedIds.has(item.id);
    const selectionMarker = selectedForBulk ? this.theme.fg("accent", "  selected") : "";
    const prefix = this.getSelectedItem()?.id === item.id ? this.theme.fg("accent", "› ") : "  ";
    return truncateToWidth(
      prefix + formatUnifiedItemLabel(item, state, this.theme, changed) + selectionMarker,
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

  private moveSelection(delta: number, wrap = false): void {
    this.selectedIndex = moveListSelection(this.selectedIndex, delta, this.filteredItems.length, {
      wrap,
    });
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    return getCenteredVisibleRange(
      this.selectedIndex,
      this.filteredItems.length,
      this.maxVisibleItems
    );
  }
}
