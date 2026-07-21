/** Summary/stats line for the Installed workspace header. */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { type State, type UnifiedItem } from "../../types/index.js";
import { getPendingToggleChangeCount } from "../footer.js";
import { getCurrentUnifiedItemState } from "./items.js";
import { type UnifiedFilter } from "./state.js";

export function buildManagerSummary(
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>,
  theme: Theme,
  options?: {
    visibleItems?: readonly UnifiedItem[];
    filter?: UnifiedFilter;
    searchQuery?: string;
    selectedCount?: number;
  }
): string {
  const summaryItems = options?.visibleItems ?? items;
  const filtered =
    Boolean(options?.searchQuery) ||
    options?.filter === "local" ||
    options?.filter === "packages" ||
    options?.filter === "updates" ||
    options?.filter === "disabled" ||
    options?.filter === "favorites" ||
    options?.filter === "recent";
  const localCount = summaryItems.filter((item) => item.type === "local").length;
  const packageCount = summaryItems.length - localCount;
  const updateCount = summaryItems.filter(
    (item) => item.type === "package" && item.updateAvailable
  ).length;
  const disabledCount = summaryItems.filter((item) => {
    if (item.type === "local") {
      return getCurrentUnifiedItemState(item, staged) === "disabled";
    }
    return (item.extensionSummary?.disabled ?? 0) > 0;
  }).length;
  const pendingCount = getPendingToggleChangeCount(staged, byId);
  const parts = [
    filtered
      ? theme.fg("accent", `showing ${summaryItems.length} of ${items.length}`)
      : theme.fg("muted", `${items.length} item${items.length === 1 ? "" : "s"}`),
    theme.fg("muted", `${localCount} local`),
  ];

  if (packageCount > 0) {
    parts.push(theme.fg("muted", `${packageCount} package${packageCount === 1 ? "" : "s"}`));
  }

  if (updateCount > 0) {
    parts.push(theme.fg("warning", `${updateCount} update${updateCount === 1 ? "" : "s"}`));
  }

  if (disabledCount > 0) {
    parts.push(theme.fg("warning", `${disabledCount} disabled`));
  }

  if (pendingCount > 0) {
    parts.push(theme.fg("warning", `${pendingCount} unsaved`));
  }

  if ((options?.selectedCount ?? 0) > 0) {
    parts.push(theme.fg("accent", `${options?.selectedCount} selected · B to act`));
  }

  return parts.join(" • ");
}
