/**
 * UI vs non-UI mode abstractions
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { notify } from "./notify.js";

export interface ModeHandler<T> {
  ui: (ctx: ExtensionCommandContext) => Promise<T>;
  cli: (ctx: ExtensionCommandContext) => Promise<T>;
}

/**
 * Execute different logic based on UI availability
 */
export async function withMode<T>(
  ctx: ExtensionCommandContext,
  handlers: ModeHandler<T>
): Promise<T> {
  if (ctx.hasUI) {
    return handlers.ui(ctx);
  }
  return handlers.cli(ctx);
}

/**
 * Check if operation can proceed in current mode
 */
export function requireUI(ctx: ExtensionCommandContext, featureName: string): boolean {
  if (!ctx.hasUI) {
    notify(
      ctx,
      `${featureName} requires interactive mode. Use command line arguments instead.`,
      "warning"
    );
    return false;
  }
  return true;
}

/**
 * Execute operation with automatic error handling
 */
export async function tryOperation<T>(
  ctx: ExtensionCommandContext,
  operation: () => Promise<T>,
  errorMessage?: string
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (err) {
    const msg = errorMessage || (err instanceof Error ? err.message : String(err));
    notify(ctx, msg, "error");
    return undefined;
  }
}

// Re-export for convenience
export { notify } from "./notify.js";
