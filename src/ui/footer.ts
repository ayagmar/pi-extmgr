/**
 * Footer helpers for the unified extension manager UI
 */
import { type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type State, type UnifiedItem } from "../types/index.js";
import { activeKeyHint } from "../utils/key-hints.js";

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
export function buildFooterShortcuts(state: FooterState, keybindings?: KeybindingsManager): string {
  const confirm = keybindings
    ? activeKeyHint(keybindings, "tui.select.confirm", "actions")
    : "Enter actions";
  const cancel = keybindings
    ? activeKeyHint(keybindings, "tui.select.cancel", "clear/cancel")
    : "Esc clear/cancel";
  const parts = ["↑↓ navigate", confirm, "/ search", "Tab filters"];

  if (state.selectedType === "local") parts.splice(1, 0, "Space toggle", "V details", "X remove");
  if (state.selectedType === "package") {
    parts.splice(1, 0, "Space select");
    if (state.expandable) parts.splice(2, 0, "E expand");
  }
  if (state.selectedPackages > 0) {
    parts.push(`${state.selectedPackages} selected · B bulk actions`);
  }
  if (state.pendingChanges > 0) parts.push(`S save (${state.pendingChanges})`);

  return `${parts.join(" · ")}\nMore: 1-7 filters · W/L/D views · * favorite · i install · f search · U update all · t auto-update · P palette · R browse · ? help · ${cancel}`;
}
