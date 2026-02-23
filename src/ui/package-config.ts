/**
 * Package extension configuration panel.
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SettingsList,
  Spacer,
  Text,
  type SettingItem,
} from "@mariozechner/pi-tui";
import type { InstalledPackage, PackageExtensionEntry, State } from "../types/index.js";
import { discoverPackageExtensions, setPackageExtensionState } from "../packages/extensions.js";
import { notify } from "../utils/notify.js";
import { logExtensionToggle } from "../utils/history.js";
import { getPackageSourceKind } from "../utils/package-source.js";
import { fileExists } from "../utils/fs.js";
import { UI } from "../constants.js";
import { getChangeMarker, getPackageIcon, getScopeIcon, getStatusIcon } from "./theme.js";

interface SelectableList {
  selectedIndex?: number;
  handleInput?(data: string): void;
}

export interface PackageConfigRow {
  id: string;
  extensionPath: string;
  summary: string;
  originalState: State;
  available: boolean;
}

type ConfigurePanelAction = { type: "cancel" } | { type: "save" };

function getSelectedIndex(settingsList: unknown): number | undefined {
  if (settingsList && typeof settingsList === "object") {
    const selectable = settingsList as SelectableList;
    if (typeof selectable.selectedIndex === "number") {
      return selectable.selectedIndex;
    }
  }
  return undefined;
}

export async function buildPackageConfigRows(
  entries: PackageExtensionEntry[]
): Promise<PackageConfigRow[]> {
  const dedupedEntries = new Map<string, PackageExtensionEntry>();
  for (const entry of entries) {
    if (!dedupedEntries.has(entry.extensionPath)) {
      dedupedEntries.set(entry.extensionPath, entry);
    }
  }

  const rows = await Promise.all(
    Array.from(dedupedEntries.values()).map(async (entry) => ({
      id: entry.id,
      extensionPath: entry.extensionPath,
      summary: entry.summary,
      originalState: entry.state,
      available: await fileExists(entry.absolutePath),
    }))
  );

  rows.sort((a, b) => a.extensionPath.localeCompare(b.extensionPath));
  return rows;
}

function formatConfigRowLabel(
  row: PackageConfigRow,
  state: State,
  pkg: InstalledPackage,
  theme: Theme,
  changed: boolean
): string {
  const statusIcon = getStatusIcon(theme, state);
  const scopeIcon = getScopeIcon(theme, pkg.scope);
  const sourceKind = getPackageSourceKind(pkg.source);
  const pkgIcon = getPackageIcon(
    theme,
    sourceKind === "npm" || sourceKind === "git" || sourceKind === "local" ? sourceKind : "local"
  );
  const changeMarker = getChangeMarker(theme, changed);
  const name = theme.bold(row.extensionPath);
  const availability = row.available
    ? ""
    : ` ${theme.fg("warning", "[missing]")}${theme.fg("dim", " (cannot toggle)")}`;
  const summary = theme.fg("dim", row.summary);

  return `${statusIcon} ${pkgIcon} [${scopeIcon}] ${name}${availability} - ${summary}${changeMarker}`;
}

function buildSettingItems(
  rows: PackageConfigRow[],
  staged: Map<string, State>,
  pkg: InstalledPackage,
  theme: Theme
): SettingItem[] {
  return rows.map((row) => {
    const current = staged.get(row.id) ?? row.originalState;
    const changed = current !== row.originalState;

    return {
      id: row.id,
      label: formatConfigRowLabel(row, current, pkg, theme, changed),
      currentValue: current,
      values: row.available ? ["enabled", "disabled"] : [current],
    };
  });
}

function getPendingChangeCount(rows: PackageConfigRow[], staged: Map<string, State>): number {
  let count = 0;

  for (const row of rows) {
    const target = staged.get(row.id);
    if (!target) continue;
    if (target !== row.originalState) count += 1;
  }

  return count;
}

async function showConfigurePanel(
  pkg: InstalledPackage,
  rows: PackageConfigRow[],
  staged: Map<string, State>,
  ctx: ExtensionCommandContext
): Promise<ConfigurePanelAction> {
  return ctx.ui.custom<ConfigurePanelAction>((tui, theme, _keybindings, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold(`Configure extensions: ${pkg.name}`)), 2, 0)
    );
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          `${rows.length} extension path${rows.length === 1 ? "" : "s"} • Space/Enter toggle • S save • Esc cancel`
        ),
        2,
        0
      )
    );
    container.addChild(new Spacer(1));

    const settingsItems = buildSettingItems(rows, staged, pkg, theme);
    const rowById = new Map(rows.map((row) => [row.id, row]));

    const settingsList = new SettingsList(
      settingsItems,
      Math.min(rows.length + 2, UI.maxListHeight),
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        const row = rowById.get(id);
        if (!row || !row.available) return;

        const state = newValue as State;
        staged.set(id, state);

        const settingsItem = settingsItems.find((item) => item.id === id);
        if (settingsItem) {
          settingsItem.label = formatConfigRowLabel(
            row,
            state,
            pkg,
            theme,
            state !== row.originalState
          );
        }

        tui.requestRender();
      },
      () => done({ type: "cancel" }),
      { enableSearch: rows.length > UI.searchThreshold }
    );

    container.addChild(settingsList);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("dim", "↑↓ Navigate | Space/Enter Toggle | S Save | Esc Back"), 2, 0)
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
          done({ type: "save" });
          return;
        }

        const selectedIndex = getSelectedIndex(settingsList) ?? 0;
        const selectedId = settingsItems[selectedIndex]?.id ?? settingsItems[0]?.id;
        const selectedRow = selectedId ? rowById.get(selectedId) : undefined;

        if (
          selectedRow &&
          !selectedRow.available &&
          (data === " " || data === "\r" || data === "\n")
        ) {
          notify(
            ctx,
            `${selectedRow.extensionPath} is missing on disk and cannot be toggled.`,
            "warning"
          );
          return;
        }

        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

export async function applyPackageExtensionChanges(
  rows: PackageConfigRow[],
  staged: Map<string, State>,
  pkg: InstalledPackage,
  cwd: string,
  pi: ExtensionAPI
): Promise<{ changed: number; errors: string[] }> {
  let changed = 0;
  const errors: string[] = [];

  const sortedRows = [...rows].sort((a, b) => a.extensionPath.localeCompare(b.extensionPath));

  for (const row of sortedRows) {
    const target = staged.get(row.id) ?? row.originalState;
    if (target === row.originalState) continue;

    if (!row.available) {
      const error = `${row.extensionPath}: extension entrypoint is missing on disk`;
      errors.push(error);
      logExtensionToggle(pi, row.id, row.originalState, target, false, error);
      continue;
    }

    const result = await setPackageExtensionState(
      pkg.source,
      row.extensionPath,
      pkg.scope,
      target,
      cwd
    );

    if (result.ok) {
      changed += 1;
      logExtensionToggle(pi, row.id, row.originalState, target, true);
    } else {
      errors.push(`${row.extensionPath}: ${result.error}`);
      logExtensionToggle(pi, row.id, row.originalState, target, false, result.error);
    }
  }

  return { changed, errors };
}

async function promptRestartForPackageConfig(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) {
    notify(
      ctx,
      "Restart pi to apply package extension configuration changes. /reload may not be enough.",
      "warning"
    );
    return false;
  }

  const restartNow = await ctx.ui.confirm(
    "Restart Required",
    "Package extension configuration changed.\nA full pi restart is required to apply it.\nExit pi now?"
  );

  if (!restartNow) {
    notify(
      ctx,
      "Restart pi manually to apply package extension configuration changes. /reload may not be enough.",
      "warning"
    );
    return false;
  }

  notify(ctx, "Shutting down pi. Start it again to apply changes.", "info");
  ctx.shutdown();
  return true;
}

export async function configurePackageExtensions(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<{ changed: number; reloaded: boolean }> {
  const discovered = await discoverPackageExtensions([pkg], ctx.cwd);
  const rows = await buildPackageConfigRows(discovered);

  if (rows.length === 0) {
    notify(ctx, "No configurable extensions discovered for this package.", "info");
    return { changed: 0, reloaded: false };
  }

  const staged = new Map<string, State>();

  while (true) {
    const action = await showConfigurePanel(pkg, rows, staged, ctx);

    if (action.type === "cancel") {
      const pending = getPendingChangeCount(rows, staged);
      if (pending === 0) {
        return { changed: 0, reloaded: false };
      }

      const choice = await ctx.ui.select(`Unsaved changes (${pending})`, [
        "Save and back",
        "Discard changes",
        "Stay in configure",
      ]);

      if (!choice || choice === "Stay in configure") {
        continue;
      }

      if (choice === "Discard changes") {
        return { changed: 0, reloaded: false };
      }
    }

    const apply = await applyPackageExtensionChanges(rows, staged, pkg, ctx.cwd, pi);

    if (apply.errors.length > 0) {
      notify(
        ctx,
        `Applied ${apply.changed} change(s), ${apply.errors.length} failed.\n${apply.errors.join("\n")}`,
        "warning"
      );
    } else if (apply.changed === 0) {
      notify(ctx, "No changes to apply.", "info");
      return { changed: 0, reloaded: false };
    } else {
      notify(ctx, `Applied ${apply.changed} package extension change(s).`, "info");
    }

    if (apply.changed === 0) {
      return { changed: 0, reloaded: false };
    }

    const restarted = await promptRestartForPackageConfig(ctx);
    return { changed: apply.changed, reloaded: restarted };
  }
}
