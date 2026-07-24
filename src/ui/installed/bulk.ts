/** Coordinated bulk package operations for the Installed workspace. */
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getPackageCatalog } from "../../packages/catalog.js";
import { applyPackageExtensionStateChanges } from "../../packages/extensions.js";
import { type State, type UnifiedItem } from "../../types/index.js";
import { parseChoiceByLabel } from "../../utils/command.js";
import { isProjectTrusted } from "../../utils/mode.js";
import { normalizePackageIdentity } from "../../utils/package-source.js";
import { confirmReload } from "../../utils/ui-helpers.js";
import { runTaskWithLoader } from "../async-task.js";
import { showReport } from "../report.js";

export const BULK_ACTION_OPTIONS = {
  update: "Update selected packages",
  remove: "Remove selected packages",
  enable: "Enable selected package extensions",
  disable: "Disable selected package extensions",
  cancel: "Cancel",
} as const;

type BulkActionKey = keyof typeof BULK_ACTION_OPTIONS;
type PackageUnifiedItem = Extract<UnifiedItem, { type: "package" }>;

interface BulkResults {
  completed: string[];
  failed: string[];
  skipped: string[];
}

async function runBulkOperation(
  action: Exclude<BulkActionKey, "cancel">,
  selectedPackages: PackageUnifiedItem[],
  ctx: ExtensionCommandContext
): Promise<BulkResults | undefined> {
  return runTaskWithLoader(
    ctx,
    {
      title: "Bulk package operation",
      message: `${BULK_ACTION_OPTIONS[action]}...`,
      cancellable: false,
      fallbackWithoutLoader: true,
      overlay: true,
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
            if (!availableUpdates?.has(`${item.scope}\0${normalizePackageIdentity(item.source)}`)) {
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
}

/**
 * Prompt for, run, and summarize a bulk package operation.
 * Returns true when a reload happened, otherwise "resume".
 */
export async function handleBulkAction(
  itemIds: string[],
  requestedAction: "menu" | Exclude<BulkActionKey, "cancel">,
  byId: Map<string, UnifiedItem>,
  ctx: ExtensionCommandContext
): Promise<boolean | "resume"> {
  const selectedPackages = itemIds
    .map((id) => byId.get(id))
    .filter((item): item is PackageUnifiedItem => item?.type === "package");
  if (selectedPackages.length === 0) return "resume";

  const action =
    requestedAction === "menu"
      ? parseChoiceByLabel(
          BULK_ACTION_OPTIONS,
          await ctx.ui.select(
            `${selectedPackages.length} selected packages`,
            Object.values(BULK_ACTION_OPTIONS)
          )
        )
      : requestedAction;
  if (!action || action === "cancel") return "resume";

  const confirmed = await ctx.ui.confirm(
    "Bulk package operation",
    `${BULK_ACTION_OPTIONS[action]} for ${selectedPackages.length} package(s)?`
  );
  if (!confirmed) return "resume";

  const results = await runBulkOperation(action, selectedPackages, ctx);
  if (!results) return "resume";

  await showReport(ctx, {
    title: "Bulk package operation",
    placement: "center",
    level: results.failed.length > 0 ? "warning" : "info",
    lines: [
      `${results.completed.length} succeeded`,
      `${results.failed.length} failed`,
      `${results.skipped.length} skipped`,
      results.completed.length > 0
        ? "Reload required: confirm Reload Required to apply changes."
        : "Reload required: no",
      ...results.failed.map((failure) => `- ${failure}`),
      ...results.skipped.map((skipped) => `- ${skipped}`),
    ],
  });
  if (results.completed.length === 0) return "resume";

  return confirmReload(ctx, "Bulk package changes completed.");
}
