/**
 * Footer helpers for the unified extension manager UI
 */
import { type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type State, type UnifiedItem } from "../types/index.js";
import { activeKeyHint } from "../utils/key-hints.js";

export interface FooterState {
  selectedType?: UnifiedItem["type"];
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
export function buildFooterShortcuts(state: FooterState, keybindings?: KeybindingsManager): string {
  const confirm = keybindings
    ? activeKeyHint(keybindings, "tui.select.confirm", "actions")
    : "Enter actions";
  const cancel = keybindings ? activeKeyHint(keybindings, "tui.select.cancel", "back") : "Esc back";
  const parts = ["↑↓ move", confirm];

  if (state.selectedType === "local") parts.push("Space toggle");
  if (state.selectedType === "package") parts.push("Space select");
  if (state.selectedPackages > 0) parts.push(`B act on ${state.selectedPackages}`);
  if (state.pendingChanges > 0) parts.push(`S save ${state.pendingChanges}`);
  parts.push("/ search", "1-7 filter", "i install", "Tab screens", "? help", cancel);

  return parts.join(" · ");
}
