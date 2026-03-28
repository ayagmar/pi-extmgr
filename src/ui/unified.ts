/**
 * Unified extension manager UI
 * Displays local extensions and installed packages in one view
 */
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getSettingsListTheme,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
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
import { dynamicTruncate, formatBytes, formatEntry as formatExtEntry } from "../utils/format.js";
import { logExtensionDelete, logExtensionToggle } from "../utils/history.js";
import { hasCustomUI, runCustomUI } from "../utils/mode.js";
import { notify } from "../utils/notify.js";
import { getPackageSourceKind, normalizePackageIdentity } from "../utils/package-source.js";
import { getSettingsListSelectedIndex } from "../utils/settings-list.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmReload } from "../utils/ui-helpers.js";
import { runTaskWithLoader } from "./async-task.js";
import { buildFooterShortcuts, buildFooterState, getPendingToggleChangeCount } from "./footer.js";
import { showHelp } from "./help.js";
import { configurePackageExtensions } from "./package-config.js";
import { showRemote } from "./remote.js";
import {
  formatSize,
  getChangeMarker,
  getPackageIcon,
  getScopeIcon,
  getStatusIcon,
} from "./theme.js";

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
        const subtitleText = new Text("", 2, 0);
        const quickText = new Text("", 2, 0);
        const footerState = buildFooterState(items);
        const footerText = new Text("", 2, 0);

        // Header
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(titleText);
        container.addChild(subtitleText);
        container.addChild(quickText);
        container.addChild(new Spacer(1));

        // Build settings items
        const settingsItems = buildSettingsItems(items, staged, theme);
        const syncThemedContent = (): void => {
          titleText.setText(theme.fg("accent", theme.bold("Extensions Manager")));
          subtitleText.setText(
            theme.fg(
              "muted",
              `${items.length} item${items.length === 1 ? "" : "s"} • Space/Enter toggle local • Enter/A actions • c configure pkg extensions • u update pkg • x remove selected`
            )
          );
          quickText.setText(
            theme.fg(
              "dim",
              "Quick: i Install | f Search | U Update all | t Auto-update | p Palette"
            )
          );
          footerText.setText(theme.fg("dim", buildFooterShortcuts(footerState)));

          for (const settingsItem of settingsItems) {
            const item = byId.get(settingsItem.id);
            if (!item) continue;

            if (item.type === "local") {
              const currentState = staged.get(item.id) ?? item.state;
              const changed = currentState !== item.originalState;
              settingsItem.label = formatUnifiedItemLabel(item, currentState, theme, changed);
            } else {
              settingsItem.label = formatUnifiedItemLabel(item, "enabled", theme, false);
            }
          }
        };
        syncThemedContent();

        const settingsList = new SettingsList(
          settingsItems,
          Math.min(items.length + 2, UI.maxListHeight),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            const item = byId.get(id);
            if (!item || item.type !== "local") return;

            const state = newValue as State;
            if (state === item.originalState) {
              staged.delete(id);
            } else {
              staged.set(id, state);
            }

            const settingsItem = settingsItems.find((x) => x.id === id);
            if (settingsItem) {
              const changed = state !== item.originalState;
              settingsItem.label = formatUnifiedItemLabel(item, state, theme, changed);
            }
            tui.requestRender();
          },
          () => done({ type: "cancel" })
        );

        container.addChild(settingsList);
        container.addChild(new Spacer(1));

        // Footer with keyboard shortcuts
        container.addChild(footerText);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
            syncThemedContent();
          },
          handleInput(data: string) {
            const selIdx = getSettingsListSelectedIndex(settingsList) ?? 0;
            const selectedId = settingsItems[selIdx]?.id ?? settingsItems[0]?.id;
            const selectedItem = selectedId ? byId.get(selectedId) : undefined;

            if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
              done({ type: "apply" });
              return;
            }

            // Enter on a package opens its action menu (fewer clicks)
            if (
              (data === "\r" || data === "\n") &&
              selectedId &&
              selectedItem?.type === "package"
            ) {
              done({ type: "action", itemId: selectedId, action: "menu" });
              return;
            }

            if (data === "a" || data === "A") {
              if (selectedId) {
                done({ type: "action", itemId: selectedId, action: "menu" });
              }
              return;
            }

            // Quick actions (global)
            if (data === "i") {
              done({ type: "quick", action: "install" });
              return;
            }
            if (data === "f") {
              done({ type: "quick", action: "search" });
              return;
            }
            if (data === "U") {
              done({ type: "quick", action: "update-all" });
              return;
            }
            if (data === "t" || data === "T") {
              done({ type: "quick", action: "auto-update" });
              return;
            }

            // Fast actions on selected row
            if (selectedId && selectedItem?.type === "package") {
              if (data === "u") {
                done({ type: "action", itemId: selectedId, action: "update" });
                return;
              }
              if (data === "x" || data === "X") {
                done({ type: "action", itemId: selectedId, action: "remove" });
                return;
              }
              if (data === "v" || data === "V") {
                done({ type: "action", itemId: selectedId, action: "details" });
                return;
              }
              if (data === "c" || data === "C") {
                done({ type: "action", itemId: selectedId, action: "configure" });
                return;
              }
            }

            if (selectedId && selectedItem?.type === "local") {
              if (data === "x" || data === "X") {
                done({ type: "action", itemId: selectedId, action: "remove" });
                return;
              }
            }

            if (data === "r" || data === "R") {
              done({ type: "remote" });
              return;
            }
            if (data === "?" || data === "h" || data === "H") {
              done({ type: "help" });
              return;
            }
            if (data === "m" || data === "M" || data === "p" || data === "P") {
              done({ type: "menu" });
              return;
            }
            settingsList.handleInput?.(data);
            tui.requestRender();
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

function normalizePathForDuplicateCheck(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const looksWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") || value.includes("\\");

  return looksWindowsPath ? normalized.toLowerCase() : normalized;
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
    localPaths.add(normalizePathForDuplicateCheck(entry.activePath));
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
    const pkgSourceNormalized = normalizePathForDuplicateCheck(pkg.source);
    const pkgResolvedNormalized = pkg.resolvedPath
      ? normalizePathForDuplicateCheck(pkg.resolvedPath)
      : "";

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

function buildSettingsItems(
  items: UnifiedItem[],
  staged: Map<string, State>,
  theme: Theme
): SettingItem[] {
  return items.map((item) => {
    if (item.type === "local") {
      const currentState = staged.get(item.id) ?? item.state;
      const changed = currentState !== item.originalState;
      return {
        id: item.id,
        label: formatUnifiedItemLabel(item, currentState, theme, changed),
        currentValue: currentState,
        values: ["enabled", "disabled"],
      };
    }

    return {
      id: item.id,
      label: formatUnifiedItemLabel(item, "enabled", theme, false),
      currentValue: "enabled",
      values: ["enabled"],
    };
  });
}

function formatUnifiedItemLabel(
  item: UnifiedItem,
  state: State,
  theme: Theme,
  changed = false
): string {
  if (item.type === "local") {
    const statusIcon = getStatusIcon(theme, state);
    const scopeIcon = getScopeIcon(theme, item.scope);
    const changeMarker = getChangeMarker(theme, changed);
    const name = theme.bold(item.displayName);
    const summary = theme.fg("dim", item.summary);
    return `${statusIcon} [${scopeIcon}] ${name} - ${summary}${changeMarker}`;
  }

  const sourceKind = getPackageSourceKind(item.source);
  const pkgIcon = getPackageIcon(
    theme,
    sourceKind === "npm" || sourceKind === "git" || sourceKind === "local" ? sourceKind : "local"
  );
  const scopeIcon = getScopeIcon(theme, item.scope);
  const name = theme.bold(item.displayName);
  const version = item.version ? theme.fg("dim", `@${item.version}`) : "";
  const updateBadge = item.updateAvailable ? ` ${theme.fg("warning", "[update]")}` : "";

  // Build info parts
  const infoParts: string[] = [];

  // Show description if available
  // Reserved space: icon (2) + scope (3) + name (~25) + version (~10) + separator (3) = ~43 chars
  if (item.description) {
    infoParts.push(dynamicTruncate(item.description, 43));
  } else if (sourceKind === "npm") {
    infoParts.push("npm");
  } else if (sourceKind === "git") {
    infoParts.push("git");
  } else {
    infoParts.push("local");
  }

  // Show size if available
  if (item.size !== undefined) {
    infoParts.push(formatSize(theme, item.size));
  }

  const summary = theme.fg("dim", infoParts.join(" • "));
  return `${pkgIcon} [${scopeIcon}] ${name}${version}${updateBadge} - ${summary}`;
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

const PACKAGE_ACTION_OPTIONS = {
  configure: "Configure extensions",
  update: "Update package",
  remove: "Remove package",
  details: "View details",
  back: "Back to manager",
} as const;

type PackageActionKey = keyof typeof PACKAGE_ACTION_OPTIONS;

type PackageActionSelection = Exclude<PackageActionKey, "back"> | "cancel";

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

    const pendingDestination = item.type === "local" ? "remove extension" : "package actions";
    const pending = await resolvePendingChangesBeforeLeave(
      items,
      staged,
      byId,
      ctx,
      pi,
      pendingDestination
    );
    if (pending === "stay") return false;

    if (item.type === "local") {
      if (result.action !== "remove") return false;

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
      case "details": {
        const sizeStr = pkg.size !== undefined ? `\nSize: ${formatBytes(pkg.size)}` : "";
        ctx.ui.notify(
          `Name: ${pkg.name}\nVersion: ${pkg.version || "unknown"}\nSource: ${pkg.source}\nScope: ${pkg.scope}${sizeStr}${pkg.description ? `\nDescription: ${pkg.description}` : ""}`,
          "info"
        );
        return false;
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

    const result = await setExtensionState(
      { activePath: item.activePath, disabledPath: item.disabledPath },
      target
    );

    if (result.ok) {
      changed++;
      logExtensionToggle(pi, item.id, item.originalState, target, true);
    } else {
      errors.push(`${item.id}: ${result.error}`);
      logExtensionToggle(pi, item.id, item.originalState, target, false, result.error);
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
    const msg = "No extensions found in ~/.pi/agent/extensions or .pi/extensions";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  const lines = entries.map(formatExtEntry);
  const output = lines.join("\n");
  const titledOutput = `Local extensions:\n${output}`;

  if (ctx.hasUI) {
    ctx.ui.notify(titledOutput, "info");
  } else {
    console.log("Local extensions:");
    console.log(output);
  }
}
