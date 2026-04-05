/**
 * Footer helpers for the unified extension manager UI
 */
import { type State, type UnifiedItem } from "../types/index.js";

export interface FooterState {
  selectedType?: UnifiedItem["type"];
  pendingChanges: number;
}

export function buildFooterState(
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  selectedItem?: UnifiedItem
): FooterState {
  return selectedItem
    ? {
        selectedType: selectedItem.type,
        pendingChanges: getPendingToggleChangeCount(staged, byId),
      }
    : {
        pendingChanges: getPendingToggleChangeCount(staged, byId),
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

    if (item.type === "local" && item.originalState !== state) {
      count += 1;
    }
  }

  return count;
}

/**
 * Build contextual keyboard shortcuts text for the footer.
 */
export function buildFooterShortcuts(state: FooterState): string {
  const parts: string[] = [];

  if (state.selectedType === "local") {
    parts.push("Space toggle");
    parts.push("Enter/A actions");
    parts.push("V details");
    parts.push("X remove");
  }

  if (state.selectedType === "package") {
    parts.push("Enter/A actions");
    parts.push("V details");
    parts.push("c configure");
    parts.push("u update");
    parts.push("X remove");
  }

  if (state.pendingChanges > 0) {
    parts.push(`S save (${state.pendingChanges})`);
  }

  parts.push("/ search");
  parts.push("Tab filters");
  parts.push("1-5 filters");
  parts.push("i install");
  parts.push("f remote search");
  parts.push("U update all");
  parts.push("t auto-update");
  parts.push("P palette");
  parts.push("R browse");
  parts.push("? help");
  parts.push("Esc clear/cancel");

  return parts.join(" · ");
}
