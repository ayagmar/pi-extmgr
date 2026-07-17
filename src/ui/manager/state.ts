import { type SavedView } from "../../utils/views.js";

export type UnifiedFilter =
  | "all"
  | "local"
  | "packages"
  | "updates"
  | "disabled"
  | "favorites"
  | "recent";

export interface UnifiedManagerViewState {
  filter: UnifiedFilter;
  searchQuery: string;
  selectedItemId?: string;
  selectedItemIds: string[];
}

export const UNIFIED_FILTER_OPTIONS: Array<{ id: UnifiedFilter; key: string; label: string }> = [
  { id: "all", key: "1", label: "All" },
  { id: "local", key: "2", label: "Local" },
  { id: "packages", key: "3", label: "Packages" },
  { id: "updates", key: "4", label: "Updates" },
  { id: "disabled", key: "5", label: "Disabled" },
  { id: "favorites", key: "6", label: "Favorites" },
  { id: "recent", key: "7", label: "Recent" },
];

function isUnifiedFilter(value: string): value is UnifiedFilter {
  return UNIFIED_FILTER_OPTIONS.some((option) => option.id === value);
}

export function viewToManagerState(
  view: SavedView | undefined
): UnifiedManagerViewState | undefined {
  if (!view || !isUnifiedFilter(view.filter)) return undefined;
  return {
    filter: view.filter,
    searchQuery: view.searchQuery,
    ...(view.selectedItemId ? { selectedItemId: view.selectedItemId } : {}),
    selectedItemIds: [...(view.selectedItemIds ?? [])],
  };
}

export function managerStateToView(
  state: UnifiedManagerViewState,
  name: string,
  now = Date.now()
): SavedView {
  return {
    name,
    filter: state.filter,
    searchQuery: state.searchQuery,
    ...(state.selectedItemId ? { selectedItemId: state.selectedItemId } : {}),
    selectedItemIds: [...state.selectedItemIds],
    createdAt: now,
    updatedAt: now,
  };
}
