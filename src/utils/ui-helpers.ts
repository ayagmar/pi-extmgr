/**
 * Common UI helper patterns
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { notify } from "./notify.js";

/**
 * Confirm and trigger reload
 * Returns true if reload was triggered
 */
export async function confirmReload(
  ctx: ExtensionCommandContext,
  reason: string
): Promise<boolean> {
  if (!ctx.hasUI) {
    notify(ctx, `Run /reload to apply changes. (${reason})`);
    return false;
  }

  const confirmed = await ctx.ui.confirm("Reload Required", `${reason}\nReload pi now?`);

  if (confirmed) {
    const reload = (ctx as ExtensionCommandContext & { reload?: () => Promise<void> }).reload;
    if (typeof reload === "function") {
      await reload.call(ctx);
    } else {
      ctx.ui.setEditorText("/reload");
    }
    return true;
  }

  return false;
}

/**
 * Confirm and trigger shutdown (for actions requiring full restart)
 * Returns true if shutdown was triggered
 */
export async function confirmRestart(
  ctx: ExtensionCommandContext,
  reason: string
): Promise<boolean> {
  if (!ctx.hasUI) {
    notify(ctx, `⚠️  ${reason}\nFull restart required to complete. Exit and restart pi manually.`);
    return false;
  }

  const confirmed = await ctx.ui.confirm(
    "Restart Required",
    `${reason}\nPackage removed. Commands may still work until you restart pi. Exit now?`
  );

  if (confirmed) {
    ctx.shutdown();
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
  timeoutMs = 30000
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
 * Handle operation result with appropriate notification
 */
export function handleResult(
  ctx: ExtensionCommandContext,
  isSuccess: boolean,
  successMsg: string,
  errorMsg: string
): void {
  if (isSuccess) {
    notify(ctx, successMsg, "info");
  } else {
    notify(ctx, errorMsg, "error");
  }
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
