import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  listExtensionTrash,
  purgeExtensionTrash,
  undoExtensionTrash,
} from "../extensions/trash.js";
import { confirmAction, confirmReload, formatListOutput } from "../utils/ui-helpers.js";
import { notify } from "../utils/notify.js";

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

export async function handleTrashSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<void> {
  const action = tokens[0] ?? "list";
  if (!["list", "restore", "purge"].includes(action)) {
    notify(ctx, TRASH_USAGE, "info");
    return;
  }

  try {
    const records = await listExtensionTrash(getTrashRoot());
    if (action === "list") {
      formatListOutput(
        ctx,
        "Trash",
        records.map((record, index) => `[${index + 1}] ${record.originalPath}`)
      );
      return;
    }
    if (records.length === 0) {
      notify(ctx, "No trash records found.", "info");
      return;
    }

    if (action === "purge" && tokens[1]?.toLowerCase() === "all") {
      if (!(await confirmAction(ctx, "Purge", `Permanently delete ${records.length} record(s)?`))) {
        notify(ctx, "Purge cancelled.", "info");
        return;
      }
      for (const record of records) await purgeExtensionTrash(record);
      notify(ctx, `Purged ${records.length} record(s).`, "info");
      return;
    }

    const record = await selectRecord(ctx, action, records, tokens[1]);
    if (!record) {
      notify(ctx, TRASH_USAGE, "info");
      return;
    }
    if (action === "purge") {
      if (!(await confirmAction(ctx, "Purge", `Permanently delete ${record.originalPath}?`))) {
        notify(ctx, "Purge cancelled.", "info");
        return;
      }
      await purgeExtensionTrash(record);
      notify(ctx, `Purged ${record.originalPath}.`, "info");
      return;
    }

    if (!(await confirmAction(ctx, "Restore", `Restore ${record.originalPath}?`))) {
      notify(ctx, "Restore cancelled.", "info");
      return;
    }
    await undoExtensionTrash(record);
    notify(ctx, `Restored ${record.originalPath}.`, "info");
    await confirmReload(ctx, "A local extension was restored.");
  } catch (error) {
    notify(
      ctx,
      `${action === "restore" ? "Restore" : action === "purge" ? "Purge" : "Trash"} failed: ${error instanceof Error ? error.message : "Unexpected error"}`,
      "error"
    );
  }
}
