import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  listExtensionTrash,
  purgeExtensionTrash,
  undoExtensionTrash,
} from "../extensions/trash.js";
import { showListReport } from "../ui/report.js";
import { notify } from "../utils/notify.js";
import { confirmAction, confirmReload } from "../utils/ui-helpers.js";

const TRASH_USAGE = "Usage: /extensions trash <list|restore [index]|purge [index|all]>";

function getTrashRoot(): string {
  return join(getAgentDir(), ".extmgr-trash");
}

async function selectRecord(
  ctx: ExtensionCommandContext,
  action: string,
  records: Awaited<ReturnType<typeof listExtensionTrash>>,
  requestedIndex?: string
) {
  if (requestedIndex) {
    const index = Number(requestedIndex) - 1;
    return Number.isInteger(index) && index >= 0 ? records[index] : undefined;
  }
  if (!ctx.hasUI) return undefined;
  const choice = await ctx.ui.select(
    action === "restore" ? "Restore" : "Purge",
    records.map((record, index) => `[${index + 1}] ${record.originalPath}`)
  );
  const match = choice?.match(/^\[(\d+)\]/);
  const index = match?.[1] ? Number(match[1]) - 1 : -1;
  return index >= 0 ? records[index] : undefined;
}

/**
 * Run a trash subcommand. Resolves to true when a restore ended in an
 * accepted reload; the context is stale then and callers must stop using it.
 */
export async function handleTrashSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<boolean> {
  const action = tokens[0] ?? "list";
  if (!["list", "restore", "purge"].includes(action)) {
    notify(ctx, TRASH_USAGE, "info");
    return false;
  }

  try {
    const records = await listExtensionTrash(getTrashRoot());
    if (action === "list") {
      await showListReport(
        ctx,
        "Trash",
        records.map((record, index) => `[${index + 1}] ${record.originalPath}`)
      );
      return false;
    }
    if (records.length === 0) {
      notify(ctx, "No trash records found.", "info");
      return false;
    }

    if (action === "purge" && tokens[1]?.toLowerCase() === "all") {
      if (!(await confirmAction(ctx, "Purge", `Permanently delete ${records.length} record(s)?`))) {
        notify(ctx, "Purge cancelled.", "info");
        return false;
      }
      for (const record of records) await purgeExtensionTrash(record);
      notify(ctx, `Purged ${records.length} record(s).`, "info");
      return false;
    }

    const record = await selectRecord(ctx, action, records, tokens[1]);
    if (!record) {
      notify(ctx, TRASH_USAGE, "info");
      return false;
    }
    if (action === "purge") {
      if (!(await confirmAction(ctx, "Purge", `Permanently delete ${record.originalPath}?`))) {
        notify(ctx, "Purge cancelled.", "info");
        return false;
      }
      await purgeExtensionTrash(record);
      notify(ctx, `Purged ${record.originalPath}.`, "info");
      return false;
    }

    if (!(await confirmAction(ctx, "Restore", `Restore ${record.originalPath}?`))) {
      notify(ctx, "Restore cancelled.", "info");
      return false;
    }
    await undoExtensionTrash(record);
    notify(ctx, `Restored ${record.originalPath}.`, "info");
    return await confirmReload(ctx, "A local extension was restored.");
  } catch (error) {
    notify(
      ctx,
      `${action === "restore" ? "Restore" : action === "purge" ? "Purge" : "Trash"} failed: ${error instanceof Error ? error.message : "Unexpected error"}`,
      "error"
    );
    return false;
  }
}
