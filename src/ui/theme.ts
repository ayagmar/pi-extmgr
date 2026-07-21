/**
 * Theme utilities for consistent UI styling across dark/light themes
 */
import { type Theme } from "@earendil-works/pi-coding-agent";

/**
 * Status icons that work across themes
 */
export function getStatusIcon(
  theme: Theme,
  status: "enabled" | "disabled" | "loading" | "success" | "error" | "warning"
): string {
  switch (status) {
    case "enabled":
      return theme.fg("success", "●");
    case "disabled":
      return theme.fg("muted", "○");
    case "loading":
      return theme.fg("accent", "◌");
    case "success":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "warning":
      return theme.fg("warning", "⚠");
  }
}

/**
 * Format extension state change indicator
 */
export function getChangeMarker(theme: Theme, hasChanges: boolean): string {
  if (!hasChanges) return "";
  return ` ${theme.fg("warning", "*")}`;
}
