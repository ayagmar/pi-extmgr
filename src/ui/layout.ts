/** Shared responsive layout primitives for the workspace screens. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const DETAIL_PANE_MIN_WIDTH = 34;
export const TWO_PANE_MIN_WIDTH = 96;

function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(0, width), "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Single source of truth for master/detail pane widths. */
export function computeTwoPaneWidths(
  width: number,
  dividerWidth: number
): { leftWidth: number; rightWidth: number } {
  const available = Math.max(2, Math.max(1, width) - dividerWidth);
  const rightWidth = Math.max(DETAIL_PANE_MIN_WIDTH, Math.floor(available * 0.38));
  const leftWidth = Math.max(1, available - rightWidth);
  return { leftWidth, rightWidth };
}

/** Compose two independently rendered surfaces without exceeding terminal width. */
export function composeColumns(
  left: string[],
  right: string[],
  width: number,
  divider: string
): string[] {
  const safeWidth = Math.max(1, width);
  const { leftWidth, rightWidth } = computeTwoPaneWidths(safeWidth, visibleWidth(divider));
  const rowCount = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    const leftLine = padToWidth(left[index] ?? "", leftWidth);
    const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "");
    lines.push(truncateToWidth(`${leftLine}${divider}${rightLine}`, safeWidth, ""));
  }

  return lines;
}

export function formatCompactCount(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 0 : 1,
  }).format(value);
}
