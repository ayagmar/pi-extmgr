/**
 * Theme utilities for consistent UI styling across dark/light themes
 */
import { type Theme } from "@mariozechner/pi-coding-agent";

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
 * Package type icons using ASCII/Unicode that work in all terminals
 */
export function getPackageIcon(theme: Theme, type: "npm" | "git" | "local" | "remote"): string {
  switch (type) {
    case "npm":
      return theme.fg("accent", "◆"); // Diamond for npm
    case "git":
      return theme.fg("warning", "◇"); // Outline diamond for git
    case "local":
      return theme.fg("dim", "▪"); // Small square for local
    case "remote":
      return theme.fg("accent", "▸"); // Arrow for remote
  }
}

/**
 * Scope indicators (Global vs Project)
 */
export function getScopeIcon(
  theme: Theme,
  scope: "global" | "project",
  options?: { dimGlobal?: boolean }
): string {
  const { dimGlobal = true } = options ?? {};
  if (scope === "global") {
    return dimGlobal ? theme.fg("muted", "G") : theme.fg("dim", "G");
  }
  return theme.fg("accent", "P");
}

/**
 * Format extension state change indicator
 */
export function getChangeMarker(theme: Theme, hasChanges: boolean): string {
  if (!hasChanges) return "";
  return ` ${theme.fg("warning", "*")}`;
}

/**
 * Create a spinner character for loading states
 */
export function getSpinner(theme: Theme, frame: number): string {
  const frames = ["◐", "◓", "◑", "◒"];
  return theme.fg("accent", frames[frame % frames.length] ?? "◐");
}

/**
 * Format a size string with appropriate color
 */
export function formatSize(theme: Theme, sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return theme.fg("dim", `${sizeBytes}B`);
  } else if (sizeBytes < 1024 * 1024) {
    return theme.fg("dim", `${(sizeBytes / 1024).toFixed(1)}KB`);
  } else {
    return theme.fg("warning", `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`);
  }
}
