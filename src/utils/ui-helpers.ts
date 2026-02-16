/**
 * Common UI helper patterns
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { notify } from "./notify.js";
import { UI } from "../constants.js";

/**
 * Confirm and trigger reload
 * Returns true if reload was triggered
 */
export async function confirmReload(
  ctx: ExtensionCommandContext,
  reason: string
): Promise<boolean> {
  if (!ctx.hasUI) {
    notify(ctx, `Reload pi to apply changes. (${reason})`);
    return false;
  }

  const confirmed = await ctx.ui.confirm("Reload Required", `${reason}\nReload pi now?`);

  if (confirmed) {
    await (ctx as ExtensionCommandContext & { reload: () => Promise<void> }).reload();
    return true;
  }

  return false;
}

/**
 * Confirm action with timeout
 */
export async function confirmAction(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
  timeoutMs: number = UI.confirmTimeout as number
): Promise<boolean> {
  if (!ctx.hasUI) {
    // In non-interactive mode, assume yes for automated workflows
    return true;
  }

  return ctx.ui.confirm(title, message, { timeout: timeoutMs });
}

/**
 * Show progress notification that works in both modes
 */
export function showProgress(ctx: ExtensionCommandContext, action: string, target: string): void {
  const message = `${action} ${target}...`;
  notify(ctx, message, "info");
}

/**
 * Format list output for display
 */
export function formatListOutput(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[]
): void {
  if (items.length === 0) {
    notify(ctx, `No ${title.toLowerCase()} found.`, "info");
    return;
  }

  const output = items.join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(`${title}:`);
    console.log(output);
  }
}
