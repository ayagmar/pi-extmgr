/**
 * Footer helpers for the unified extension manager UI
 */
import type { UnifiedItem, State } from "../types/index.js";

export interface FooterState {
  hasToggleRows: boolean;
  hasLocals: boolean;
  hasPackages: boolean;
}

/**
 * Build footer state from visible items.
 */
export function buildFooterState(items: UnifiedItem[]): FooterState {
  const hasLocals = items.some((i) => i.type === "local");
  const hasPackageExtensions = items.some((i) => i.type === "package-extension");

  return {
    hasToggleRows: hasLocals || hasPackageExtensions,
    hasLocals,
    hasPackages: items.some((i) => i.type === "package"),
  };
}

export function getPendingToggleChangeCount(
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>
): number {
  let count = 0;

  for (const [id, state] of staged.entries()) {
    const item = byId.get(id);
    if (!item) continue;

    if (
      (item.type === "local" || item.type === "package-extension") &&
      item.originalState !== state
    ) {
      count += 1;
    }
  }

  return count;
}

/**
 * Build keyboard shortcuts text for the footer.
 */
export function buildFooterShortcuts(state: FooterState): string {
  const parts: string[] = [];
  parts.push("↑↓ Navigate");

  if (state.hasToggleRows) parts.push("Space/Enter Toggle");
  if (state.hasToggleRows) parts.push("S Save");
  if (state.hasPackages) parts.push("Enter/A Actions");
  if (state.hasPackages) parts.push("u Update");
  if (state.hasPackages || state.hasLocals) parts.push("X Remove");

  parts.push("i Install");
  parts.push("f Search");
  parts.push("U Update all");
  parts.push("t Auto-update");
  parts.push("P Palette");
  parts.push("R Browse");
  parts.push("? Help");
  parts.push("Esc Cancel");

  return parts.join(" | ");
}
