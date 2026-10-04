/**
 * Action dispatch for the Installed workspace.
 *
 * Cohesive flows live in sibling modules: ./item-actions (single-item menus
 * and mutations), ./bulk (coordinated package operations), ./views (saved
 * views and favorites). This module owns staged-toggle application, the
 * pending-changes guard, and navigation to other workspaces.
 */
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setExtensionState } from "../../extensions/discovery.js";
import { updatePackagesWithOutcome } from "../../packages/management.js";
import {
  type LocalUnifiedItem,
  type State,
  type UnifiedAction,
  type UnifiedItem,
} from "../../types/index.js";
import { promptAutoUpdateWizard } from "../../utils/auto-update.js";
import { parseChoiceByLabel } from "../../utils/command.js";
import { logExtensionToggle } from "../../utils/history.js";
import { markReloadRequired } from "../../utils/reload-state.js";
import { updateExtmgrStatus } from "../../utils/status.js";
import { confirmReload } from "../../utils/ui-helpers.js";
import { type readSavedViews } from "../../utils/views.js";
import { getPendingToggleChangeCount } from "../footer.js";
import { showHelp } from "../help.js";
import { showRemote } from "../remote.js";
import { runAuxWorkspaceScreens } from "../workspace/router.js";
import { handleBulkAction } from "./bulk.js";
import {
  handleLocalItemAction,
  handlePackageItemAction,
  type LocalActionSelection,
  type PackageActionSelection,
} from "./item-actions.js";
import { getToggleItemsForApply } from "./items.js";
import { type UnifiedManagerViewState } from "./state.js";
import { handleViewsAction } from "./views.js";

async function applyStagedChanges(
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
      if (!reloaded) void updateExtmgrStatus(ctx, pi);
      return { changed: apply.changed, reloaded, hasErrors: apply.errors.length > 0 };
    }

    await markReloadRequired("Local extensions changed.");
    ctx.ui.notify("Changes saved. Reload pi later to fully apply extension state updates.", "info");
    void updateExtmgrStatus(ctx, pi);
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

async function navigateWithPendingGuard(
  destination: QuickDestination,
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<"reload" | "resume" | "stay" | "exit"> {
  // Help is a transient peek, not a navigation: never disturb staged toggles.
  if (destination === "help") {
    await showHelp(ctx);
    return "resume";
  }

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
    return handleViewsAction(
      result.action,
      result.itemId,
      savedViews,
      viewsPath,
      ctx,
      currentViewState
    );
  }

  if (result.type === "bulk") {
    return handleBulkAction(result.itemIds, result.action, byId, ctx);
  }

  if (result.type === "remote") {
    const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Remote");
    if (pending === "stay") return "resume";

    return showRemote("", ctx, pi);
  }

  if (result.type === "help") {
    // Help is a floating peek, not a navigation: staged changes stay intact.
    await showHelp(ctx);
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

    const guardPendingChanges = (destinationLabel: string) =>
      resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, destinationLabel);

    if (item.type === "local") {
      return handleLocalItemAction(
        item,
        result.action as LocalActionSelection | "menu" | undefined,
        staged,
        ctx,
        pi,
        guardPendingChanges
      );
    }

    return handlePackageItemAction(
      item,
      result.action as PackageActionSelection | "menu" | undefined,
      ctx,
      pi,
      guardPendingChanges
    );
  }

  const apply = await applyToggleChangesFromManager(items, staged, ctx, pi);
  return apply.reloaded ? true : "resume";
}
