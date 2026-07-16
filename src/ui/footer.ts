/**
 * Footer helpers for the unified extension manager UI
 */
import { type State, type UnifiedItem } from "../types/index.js";

export interface FooterState {
  selectedType?: UnifiedItem["type"];
  expandable: boolean;
  pendingChanges: number;
  selectedPackages: number;
}

export function buildFooterState(
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  selectedItem?: UnifiedItem,
  selectedPackages = 0
): FooterState {
  const state: FooterState = {
    pendingChanges: getPendingToggleChangeCount(staged, byId),
    selectedPackages,
    expandable: selectedItem?.type === "package" && Boolean(selectedItem.extensionPaths?.length),
  };

  if (selectedItem) {
    state.selectedType = selectedItem.type;
  }

  return state;
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
    if (state.expandable) parts.push("E expand");
    parts.push("Space select · B bulk actions");
    parts.push("Enter/A actions");
    parts.push("V details");
    parts.push("c configure · scope actions in menu");
    parts.push("u update");
    parts.push("X remove");
  }

  if (state.selectedPackages > 0) {
    parts.push(`B bulk actions (${state.selectedPackages})`);
  }

  if (state.pendingChanges > 0) {
    parts.push(`S save (${state.pendingChanges})`);
  }

  parts.push("/ search");
  parts.push("Tab filters");
  parts.push("1-7 filters");
  parts.push("W save view · L load · D delete · * favorite");
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
