/**
 * Centralized notification handling for UI and non-UI modes
 */
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type NotifyLevel = "info" | "warning" | "error";

/**
 * Notify user - works in both UI and non-interactive modes
 */
export function notify(
  ctx: ExtensionCommandContext | ExtensionContext,
  message: string,
  level: NotifyLevel = "info"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    const prefix = level === "error" ? "Error: " : "";
    console.log(prefix + message);
  }
}

/**
 * Show success message
 */
export function success(ctx: ExtensionCommandContext | ExtensionContext, message: string): void {
  notify(ctx, message, "info");
}

/**
 * Show error message
 */
export function error(ctx: ExtensionCommandContext | ExtensionContext, message: string): void {
  notify(ctx, message, "error");
}

/**
 * Show warning message
 */
export function warning(ctx: ExtensionCommandContext | ExtensionContext, message: string): void {
  notify(ctx, message, "warning");
}

/**
 * Show info message
 */
export function info(ctx: ExtensionCommandContext | ExtensionContext, message: string): void {
  notify(ctx, message, "info");
}
