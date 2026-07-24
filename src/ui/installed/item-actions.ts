/** Single-item action flows for the Installed workspace: menus, details, mutations. */
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { removeLocalExtension } from "../../extensions/discovery.js";
import { undoExtensionTrash } from "../../extensions/trash.js";
import { getInstalledPackagesAllScopes } from "../../packages/discovery.js";
import { applyPackageExtensionStateChanges } from "../../packages/extensions.js";
import { removePackageWithOutcome, updatePackageWithOutcome } from "../../packages/management.js";
import { comparePackageScopes, movePackageBetweenScopes } from "../../packages/scopes.js";
import {
  type InstalledPackage,
  type LocalUnifiedItem,
  type State,
  type UnifiedItem,
} from "../../types/index.js";
import { parseChoiceByLabel } from "../../utils/command.js";
import { formatBytes } from "../../utils/format.js";
import {
  formatChangeEntry,
  logExtensionDelete,
  queryPackageTimeline,
} from "../../utils/history.js";
import { isProjectTrusted } from "../../utils/mode.js";
import { confirmReload } from "../../utils/ui-helpers.js";
import { configurePackageExtensions } from "../package-config.js";
import { showReport } from "../report.js";
import { formatPackageExtensionState } from "./formatting.js";
import { getLocalItemCurrentPath } from "./items.js";

/** Guard invoked before destructive/leaving actions while toggles are staged. */
export type PendingChangesGuard = (destinationLabel: string) => Promise<"continue" | "stay">;

const LOCAL_ACTION_OPTIONS = {
  toggle: "Toggle enabled state",
  details: "View full details",
  remove: "Remove extension",
  back: "Back",
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

export type LocalActionSelection =
  | Exclude<LocalActionKey, "back">
  | "cancel"
  | "enable"
  | "disable";
export type PackageActionSelection = Exclude<PackageActionKey, "back"> | "cancel";

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

export function buildUnifiedItemDetailLines(
  item: UnifiedItem,
  ctx: ExtensionCommandContext,
  state?: State
): string[] {
  if (item.type === "local") {
    const currentState = state ?? item.state;
    return [
      `Name: ${item.displayName}`,
      `Scope: ${item.scope}`,
      `State: ${currentState}`,
      `Path: ${getLocalItemCurrentPath(item, currentState)}`,
      `Summary: ${item.summary}`,
    ];
  }

  const extensionState = formatPackageExtensionState(item.extensionSummary);
  const timeline = queryPackageTimeline(ctx, item.source, { limit: 5 });
  return [
    `Name: ${item.displayName}`,
    `Version: ${item.version || "unknown"}`,
    `Source: ${item.source}`,
    `Scope: ${item.scope}`,
    ...(extensionState ? [`Extensions: ${extensionState}`] : []),
    ...(item.size !== undefined ? [`Size: ${formatBytes(item.size)}`] : []),
    ...(item.description ? [`Description: ${item.description}`] : []),
    "",
    "Recent activity:",
    ...(timeline.length > 0
      ? timeline.map((entry) => `- ${formatChangeEntry(entry)}`)
      : ["none in this session"]),
  ];
}

async function showUnifiedItemDetails(
  item: UnifiedItem,
  ctx: ExtensionCommandContext,
  state?: State
): Promise<void> {
  await showReport(ctx, {
    title: item.displayName,
    lines: buildUnifiedItemDetailLines(item, ctx, state),
  });
}

export async function handleLocalItemAction(
  item: LocalUnifiedItem,
  requestedAction: LocalActionSelection | "menu" | undefined,
  staged: Map<string, State>,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  guardPendingChanges: PendingChangesGuard
): Promise<boolean | "resume"> {
  const currentState = staged.get(item.id) ?? item.state;
  const selection =
    !requestedAction || requestedAction === "menu"
      ? await promptLocalActionSelection(item, currentState, ctx)
      : requestedAction;

  if (selection === "cancel") {
    return "resume";
  }

  if (selection === "toggle" || selection === "enable" || selection === "disable") {
    const target: State =
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
    await showUnifiedItemDetails(item, ctx, currentState);
    return "resume";
  }

  if (selection !== "remove") {
    return "resume";
  }

  if ((await guardPendingChanges("remove extension")) === "stay") {
    return "resume";
  }

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

  return confirmReload(ctx, "Extension removed.");
}

export async function handlePackageItemAction(
  item: Extract<UnifiedItem, { type: "package" }>,
  requestedAction: PackageActionSelection | "menu" | undefined,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  guardPendingChanges: PendingChangesGuard
): Promise<boolean | "resume"> {
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
    !requestedAction || requestedAction === "menu"
      ? await promptPackageActionSelection(pkg, ctx)
      : requestedAction;

  if (selection === "cancel") {
    return "resume";
  }

  if (selection === "details") {
    await showUnifiedItemDetails(item, ctx);
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

  if ((await guardPendingChanges(pendingDestinationBySelection[selection])) === "stay") {
    return "resume";
  }

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
        await showReport(ctx, {
          title: `Scopes: ${comparison.name}`,
          lines: [
            `Global: ${comparison.global?.source ?? "not configured"}`,
            `Project: ${comparison.project?.source ?? "not configured"}`,
            `Status: ${comparison.status}`,
          ],
        });
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
      return confirmReload(ctx, "Package scope changed.");
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
      return confirmReload(ctx, "Package extension state changed.");
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
