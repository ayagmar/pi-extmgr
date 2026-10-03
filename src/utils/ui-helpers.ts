/**
 * Common UI helper patterns
 */
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UI } from "../constants.js";
import { notify, error as notifyError } from "./notify.js";
import { clearReloadRequired, markReloadRequired } from "./reload-state.js";

const reloadedContexts = new WeakSet<object>();

/** Mark a command context unusable after a successful in-process reload. */
export function markContextReloaded(ctx: ExtensionCommandContext): void {
  reloadedContexts.add(ctx);
}

export function wasContextReloaded(ctx: ExtensionCommandContext): boolean {
  return reloadedContexts.has(ctx);
}

/**
 * Confirm and trigger reload
 * Returns true if reload was triggered
 *
 * Shortcut-handler contexts are plain ExtensionContexts without reload();
 * they mark the reload as pending instead of reloading in-process.
 */
export async function confirmReload(
  ctx: ExtensionCommandContext,
  reason: string,
  statePath?: string
): Promise<boolean> {
  await markReloadRequired(reason, statePath);

  if (!ctx.hasUI || typeof ctx.reload !== "function") {
    notify(ctx, `Reload pi to apply changes. (${reason})`);
    return false;
  }

  const confirmed = await ctx.ui.confirm("Reload Required", `${reason}\nReload pi now?`);

  if (!confirmed) {
    return false;
  }

  return reloadNow(ctx, statePath);
}

/**
 * Reload pi in-process. Returns true on success; the context is stale from
 * then on (pi throws on every ctx access), so callers must return without
 * touching it. Failures are reported and leave the reload marker in place.
 */
export async function reloadNow(
  ctx: ExtensionCommandContext,
  statePath?: string
): Promise<boolean> {
  try {
    await ctx.reload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      notifyError(ctx, `Reload failed: ${message}`);
    } catch {
      // The reload got far enough to retire this context; nothing to report to.
    }
    return false;
  }

  markContextReloaded(ctx);
  await clearReloadRequired(statePath);
  return true;
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
