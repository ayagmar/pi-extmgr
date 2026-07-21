/** Action handling for the Installed workspace: menus, staged toggles, and mutations. */
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { removeLocalExtension, setExtensionState } from "../../extensions/discovery.js";
import { undoExtensionTrash } from "../../extensions/trash.js";
import { getPackageCatalog } from "../../packages/catalog.js";
import { getInstalledPackagesAllScopes } from "../../packages/discovery.js";
import { applyPackageExtensionStateChanges } from "../../packages/extensions.js";
import {
  removePackageWithOutcome,
  updatePackagesWithOutcome,
  updatePackageWithOutcome,
} from "../../packages/management.js";
import { comparePackageScopes, movePackageBetweenScopes } from "../../packages/scopes.js";
import {
  type InstalledPackage,
  type LocalUnifiedItem,
  type State,
  type UnifiedAction,
  type UnifiedItem,
} from "../../types/index.js";
import { promptAutoUpdateWizard } from "../../utils/auto-update.js";
import { parseChoiceByLabel } from "../../utils/command.js";
import { formatBytes } from "../../utils/format.js";
import {
  formatChangeEntry,
  logExtensionDelete,
  logExtensionToggle,
  queryPackageTimeline,
} from "../../utils/history.js";
import { isProjectTrusted } from "../../utils/mode.js";
import { notify } from "../../utils/notify.js";
import { normalizePackageIdentity } from "../../utils/package-source.js";
import { markReloadRequired } from "../../utils/reload-state.js";
import { updateExtmgrStatus } from "../../utils/status.js";
import { confirmReload } from "../../utils/ui-helpers.js";
import { type readSavedViews, writeSavedViews } from "../../utils/views.js";
import { runTaskWithLoader } from "../async-task.js";
import { getPendingToggleChangeCount } from "../footer.js";
import { showHelp } from "../help.js";
import { configurePackageExtensions } from "../package-config.js";
import { showRemote } from "../remote.js";
import { runAuxWorkspaceScreens } from "../workspace/router.js";
import { formatPackageExtensionState } from "./formatting.js";
import { getLocalItemCurrentPath, getToggleItemsForApply } from "./items.js";
import { managerStateToView, type UnifiedManagerViewState } from "./state.js";

export async function applyStagedChanges(
  items: LocalUnifiedItem[],
  staged: Map<string, State>,
  pi: ExtensionAPI
): Promise<{ changed: number; errors: string[] }> {
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

export async function applyToggleChangesFromManager(
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

export async function resolvePendingChangesBeforeLeave(
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
  discover: "Discover community packages",
  profiles: "Profiles",
  health: "Health and diagnostics",
  install: "Install package by source",
  search: "Search packages",
  updateAll: "Update all packages",
  autoUpdate: "Scheduled update checks",
  help: "Help",
  back: "Back",
} as const;

type PaletteAction = keyof typeof PALETTE_OPTIONS;

type QuickDestination =
  | "discover"
  | "profiles"
  | "health"
  | "install"
  | "search"
  | "update-all"
  | "auto-update"
  | "help";

const QUICK_DESTINATION_LABELS: Record<QuickDestination, string> = {
  discover: "Discover",
  profiles: "Profiles",
  health: "Health",
  install: "Install",
  search: "Search",
  "update-all": "Update",
  "auto-update": "Scheduled update checks",
  help: "Help",
};

const LOCAL_ACTION_OPTIONS = {
  toggle: "Toggle enabled state",
  details: "View full details",
  remove: "Remove extension",
  back: "Back",
} as const;

const BULK_ACTION_OPTIONS = {
  update: "Update selected packages",
  remove: "Remove selected packages",
  enable: "Enable selected package extensions",
  disable: "Disable selected package extensions",
  cancel: "Cancel",
} as const;

const PACKAGE_ACTION_OPTIONS = {
  details: "View full details",
  configure: "Configure package extensions",
  enable: "Enable all package extensions",
  disable: "Disable all package extensions",
  update: "Update package",
  compare: "Compare scopes",
  "move-global": "Move to global scope",
  "move-project": "Move to project scope",
  remove: "Remove package",
  back: "Back",
} as const;

type LocalActionKey = keyof typeof LOCAL_ACTION_OPTIONS;
type PackageActionKey = keyof typeof PACKAGE_ACTION_OPTIONS;

type LocalActionSelection = Exclude<LocalActionKey, "back"> | "cancel";
type PackageActionSelection = Exclude<PackageActionKey, "back"> | "cancel";

async function promptLocalActionSelection(
  item: LocalUnifiedItem,
  state: State,
  ctx: ExtensionCommandContext
): Promise<LocalActionSelection> {
  const labels = {
    ...LOCAL_ACTION_OPTIONS,
    toggle: state === "enabled" ? "Disable extension" : "Enable extension",
  };
  const selection = parseChoiceByLabel(
    labels,
    await ctx.ui.select(item.displayName, Object.values(labels))
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
  const options = Object.entries(PACKAGE_ACTION_OPTIONS)
    .filter(([action]) => action !== (pkg.scope === "global" ? "move-global" : "move-project"))
    .map(([, label]) => label);
  const selection = parseChoiceByLabel(
    PACKAGE_ACTION_OPTIONS,
    await ctx.ui.select(pkg.name, options)
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
    case "discover":
      return (await showRemote("", ctx, pi)) ? "exit" : "reload";
    case "profiles":
    case "health": {
      const outcome = await runAuxWorkspaceScreens(destination, ctx, pi);
      if (outcome.reloaded) return "exit";
      if (outcome.navigate === "discover") {
        if (await showRemote("", ctx, pi)) return "exit";
      }
      return "reload";
    }
    case "install":
      return (await showRemote("install", ctx, pi)) ? "exit" : "reload";
    case "search":
      return (await showRemote("search", ctx, pi)) ? "exit" : "reload";
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

export async function handleUnifiedAction(
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
  if (result.type === "workspace") {
    if (result.screen === "installed") return "resume";
    const destination: QuickDestination = result.screen;
    const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
    if (outcome === "stay" || outcome === "resume") return "resume";
    return outcome === "exit";
  }

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

    return showRemote("", ctx, pi);
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
      await ctx.ui.select("Extmgr workspace", Object.values(PALETTE_OPTIONS))
    );

    const destinationByAction: Partial<Record<PaletteAction, QuickDestination>> = {
      discover: "discover",
      profiles: "profiles",
      health: "health",
      install: "install",
      search: "search",
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
      const currentState = staged.get(item.id) ?? item.state;
      const selection =
        !result.action || result.action === "menu"
          ? await promptLocalActionSelection(item, currentState, ctx)
          : result.action;

      if (selection === "cancel") {
        return "resume";
      }

      if (selection === "toggle" || selection === "enable" || selection === "disable") {
        const target =
          selection === "enable"
            ? "enabled"
            : selection === "disable"
              ? "disabled"
              : currentState === "enabled"
                ? "disabled"
                : "enabled";
        if (target === item.originalState) staged.delete(item.id);
        else staged.set(item.id, target);
        return "resume";
      }

      if (selection === "details") {
        showUnifiedItemDetails(item, ctx, currentState);
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
        const comparisons = comparePackageScopes(
          await getInstalledPackagesAllScopes(ctx),
          ctx.cwd
        ).filter(
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
