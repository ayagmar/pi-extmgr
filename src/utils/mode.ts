/**
 * UI capability helpers
 */
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { notify } from "./notify.js";

type AnyContext = ExtensionCommandContext | ExtensionContext;

export type UICapability = "none" | "dialog" | "custom";

export function getUICapability(ctx: AnyContext): UICapability {
  if (!ctx.hasUI) {
    return "none";
  }

  return typeof ctx.ui?.custom === "function" ? "custom" : "dialog";
}

export function hasCustomUI(ctx: AnyContext): boolean {
  return getUICapability(ctx) === "custom";
}

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

export function requireCustomUI(
  ctx: AnyContext,
  featureName: string,
  fallbackMessage?: string
): boolean {
  if (hasCustomUI(ctx)) {
    return true;
  }

  const suffix = fallbackMessage ? ` ${fallbackMessage}` : "";
  if (ctx.hasUI) {
    notify(ctx, `${featureName} requires the full interactive TUI.${suffix}`, "warning");
  } else {
    notify(ctx, `${featureName} requires interactive mode.${suffix}`, "warning");
  }
  return false;
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
