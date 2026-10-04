/**
 * Common UI helper patterns
 */
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UI } from "../constants.js";
import { notify, error as notifyError } from "./notify.js";
import { markReloadRequired } from "./reload-state.js";

const reloadedContexts = new WeakSet<object>();

/** Mark a command context unusable after a successful in-process reload. */
function markContextReloaded(ctx: ExtensionCommandContext): void {
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

  return reloadNow(ctx);
}

/** pi retires a command context once it really reloads; every access then throws. */
function isContextRetired(ctx: ExtensionCommandContext): boolean {
  try {
    void ctx.hasUI;
    return false;
  } catch {
    return true;
  }
}

/**
 * Reload pi in-process. Returns true once pi has retired this context (pi
 * throws on every ctx access from then on), so callers must return without
 * touching it.
 *
 * In the TUI ctx.reload() never rejects: pi declines while a response or
 * compaction is running and reports its own failures, resolving either way.
 * A context that is still live afterwards therefore means nothing reloaded.
 * The reload-required marker is left alone here; the session_start handler
 * clears it when a reload actually happens.
 */
export async function reloadNow(ctx: ExtensionCommandContext): Promise<boolean> {
  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
    notify(ctx, "Reload after the current response finishes (run /reload).", "warning");
    return false;
  }

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

  if (!isContextRetired(ctx)) return false;

  markContextReloaded(ctx);
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
