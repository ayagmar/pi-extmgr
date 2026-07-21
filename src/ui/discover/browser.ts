/** Interactive browse component for the Discover workspace. */
import { type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PAGE_SIZE } from "../../constants.js";
import { type RemotePackageSort, sortRemotePackages } from "../../packages/sorting.js";
import { type BrowseAction, type NpmPackage } from "../../types/index.js";
import { truncate } from "../../utils/format.js";
import { activeKeyHint } from "../../utils/key-hints.js";
import { composeColumns, formatCompactCount, TWO_PANE_MIN_WIDTH } from "../layout.js";
import { getCenteredVisibleRange, moveListSelection } from "../list-navigation.js";
import { buildWorkspaceNavigation, matchWorkspaceNavigation } from "../workspace/navigation.js";
import { formatRemotePackageDetails, formatRemotePackageLabel } from "./formatting.js";
import { type RemoteBrowseSource } from "./query.js";

export class RemotePackageBrowser implements Focusable {
  private readonly searchInput = new Input();
  private selectedIndex = 0;
  private searchActive = false;
  private sortMode: RemotePackageSort = "downloads";
  private readonly originalPackages: NpmPackage[];
  private _focused = false;

  constructor(
    private packages: NpmPackage[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly browseSource: RemoteBrowseSource,
    private readonly queryLabel: string,
    private readonly totalResults: number,
    private readonly offset: number,
    private readonly maxVisibleItems: number,
    private readonly showPrevious: boolean,
    private readonly showLoadMore: boolean,
    private readonly onAction: (action: BrowseAction) => void
  ) {
    this.originalPackages = [...packages];
    this.packages = sortRemotePackages(this.originalPackages, this.sortMode);
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

  /** Re-apply the active sort after background metadata hydration lands. */
  refreshSort(): void {
    if (this.sortMode === "relevance") return;
    const selectedName = this.packages[this.selectedIndex]?.name;
    this.packages = sortRemotePackages(this.originalPackages, this.sortMode);
    this.selectedIndex = Math.max(
      0,
      this.packages.findIndex((pkg) => pkg.name === selectedName)
    );
  }

  handleBrowseInput(data: string): boolean {
    const workspaceScreen = matchWorkspaceNavigation(data, "discover");
    if (workspaceScreen) {
      this.onAction({ type: "workspace", screen: workspaceScreen });
      return true;
    }

    if (this.searchActive) {
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.searchActive = false;
        this.searchInput.focused = false;
        this.onAction({ type: "search", query: this.searchInput.getValue().trim() });
        return true;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
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
      this.selectedIndex = Math.max(0, this.packages.length - 1);
      return true;
    }

    const selected = this.packages[this.selectedIndex];
    if (selected && this.keybindings.matches(data, "tui.select.confirm")) {
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

    if (data === "o" || data === "O") {
      const modes: RemotePackageSort[] = ["downloads", "recent", "name", "relevance"];
      const nextIndex = (modes.indexOf(this.sortMode) + 1) % modes.length;
      this.sortMode = modes[nextIndex] ?? "downloads";
      const selectedName = selected?.name;
      this.packages = sortRemotePackages(this.originalPackages, this.sortMode);
      this.selectedIndex = Math.max(
        0,
        this.packages.findIndex((pkg) => pkg.name === selectedName)
      );
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

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onAction({ type: "cancel" });
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [
      truncateToWidth(buildWorkspaceNavigation(this.theme, "discover"), safeWidth, ""),
      "",
    ];

    if (this.searchActive) {
      lines.push(...this.searchInput.render(safeWidth));
      lines.push("");
    } else if (!this.queryLabel) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            this.browseSource === "community"
              ? "  Community packages · / search"
              : "  Remote search results · / search"
          ),
          safeWidth,
          ""
        ),
        ""
      );
    }

    lines.push(truncateToWidth(this.buildSummaryLine(), safeWidth, ""));
    lines.push("");

    const listLines: string[] = [];
    if (this.packages.length === 0) {
      listLines.push(
        truncateToWidth(
          this.theme.fg("warning", "  No packages found. Try / search or Esc to go back."),
          safeWidth,
          ""
        )
      );
    }

    const { startIndex, endIndex } = this.getVisibleRange();
    for (const pkg of this.packages.slice(startIndex, endIndex)) {
      listLines.push(this.renderPackageLine(pkg, safeWidth));
    }

    if (startIndex > 0 || endIndex < this.packages.length) {
      listLines.push("");
      listLines.push(
        this.theme.fg(
          "dim",
          `  Showing ${startIndex + 1}-${endIndex} of ${this.packages.length} on this page`
        )
      );
    }

    const selected = this.packages[this.selectedIndex];
    if (selected && safeWidth >= TWO_PANE_MIN_WIDTH) {
      const detailWidth = Math.max(1, Math.floor((safeWidth - 3) * 0.38));
      lines.push(
        ...composeColumns(
          listLines,
          this.renderInspector(selected, detailWidth),
          safeWidth,
          this.theme.fg("borderMuted", " │ ")
        )
      );
    } else {
      lines.push(...listLines.map((line) => truncateToWidth(line, safeWidth, "")));
      if (selected) {
        lines.push("");
        const detailText = formatRemotePackageDetails(
          selected,
          this.offset + this.selectedIndex + 1,
          this.totalResults
        );
        for (const line of wrapTextWithAnsi(detailText, Math.max(1, safeWidth - 4))) {
          lines.push(truncateToWidth(this.theme.fg("dim", `  ${line}`), safeWidth, ""));
        }
      }
    }

    lines.push("");
    lines.push(truncateToWidth(this.buildFooterLine(), safeWidth, ""));
    return lines;
  }

  private buildSummaryLine(): string {
    const pageCount = Math.max(1, Math.ceil(this.totalResults / PAGE_SIZE));
    const pageNumber = Math.floor(this.offset / PAGE_SIZE) + 1;
    const rangeEnd = this.offset + this.packages.length;
    const label = this.queryLabel
      ? `Search: ${truncate(this.queryLabel, 40)}`
      : "Community packages";
    const sortLabel = this.sortMode === "popular" ? "downloads" : this.sortMode;
    return `  ${this.theme.fg("accent", label)} • ${this.theme.fg("muted", `${this.offset + 1}-${rangeEnd} of ${this.totalResults}`)} • ${this.theme.fg("muted", `page ${pageNumber}/${pageCount}`)} • ${this.theme.fg("muted", `sort:${sortLabel}`)}`;
  }

  private buildFooterLine(): string {
    const parts = [activeKeyHint(this.keybindings, "tui.select.confirm", "details"), "/ search"];

    if (this.showPrevious) parts.push("p previous");
    if (this.showLoadMore) parts.push("n next");
    parts.push("o sort", "m commands");
    parts.push(activeKeyHint(this.keybindings, "tui.select.cancel", "back"));
    return `  ${this.theme.fg("dim", parts.join(" · "))}`;
  }

  private renderInspector(pkg: NpmPackage, width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const lines = [
      this.theme.fg("accent", this.theme.bold("Package details")),
      "",
      this.theme.bold(pkg.name),
      pkg.version ? this.theme.fg("muted", `Version ${pkg.version}`) : "",
      "",
    ];

    for (const line of wrapTextWithAnsi(
      pkg.description || "No description provided.",
      contentWidth
    )) {
      lines.push(line);
    }

    lines.push("");
    const downloads = formatCompactCount(pkg.weeklyDownloads);
    lines.push(
      `${this.theme.fg("dim", "Weekly downloads")}  ${downloads ?? this.theme.fg("dim", "unknown")}`,
      `${this.theme.fg("dim", "Author")}            ${pkg.author ? `by ${pkg.author}` : "unknown"}`,
      `${this.theme.fg("dim", "Updated")}           ${pkg.date?.slice(0, 10) ?? "unknown"}`,
      `${this.theme.fg("dim", "Compatibility")}     ${pkg.compatibility ?? "unknown"}`
    );

    if (pkg.keywords?.length) {
      lines.push("", this.theme.fg("dim", pkg.keywords.slice(0, 6).join(" · ")));
    }
    if (pkg.installed) lines.push("", this.theme.fg("success", "Installed"));
    if (pkg.updateAvailable) lines.push(this.theme.fg("warning", "Update available"));

    return lines.map((line) => truncateToWidth(` ${line}`, width, ""));
  }

  private renderPackageLine(pkg: NpmPackage, width: number): string {
    const prefix =
      this.packages[this.selectedIndex]?.name === pkg.name ? this.theme.fg("accent", "› ") : "  ";
    return truncateToWidth(prefix + formatRemotePackageLabel(pkg, this.theme), width);
  }

  private moveSelection(delta: number, wrap = false): void {
    this.selectedIndex = moveListSelection(this.selectedIndex, delta, this.packages.length, {
      wrap,
    });
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    return getCenteredVisibleRange(this.selectedIndex, this.packages.length, this.maxVisibleItems);
  }
}
