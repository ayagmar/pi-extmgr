/** Pure formatting helpers for the Installed workspace. */
import { homedir } from "node:os";
import { relative } from "node:path";
import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  type PackageExtensionStateSummary,
  type State,
  type UnifiedItem,
} from "../../types/index.js";
import { formatBytes } from "../../utils/format.js";
import { getPackageSourceKind } from "../../utils/package-source.js";
import { getStatusIcon } from "../theme.js";
import { getLocalItemCurrentPath } from "./items.js";

export function getPackageExtensionStatusIcon(
  theme: Theme,
  summary?: PackageExtensionStateSummary
): string {
  if (!summary || summary.total === 0) return theme.fg("muted", "•");
  if (summary.disabled === 0) return getStatusIcon(theme, "enabled");
  if (summary.enabled === 0) return getStatusIcon(theme, "disabled");
  return theme.fg("warning", "●");
}

export function formatPackageExtensionState(
  summary?: PackageExtensionStateSummary
): string | undefined {
  if (!summary || summary.total === 0) return undefined;
  if (summary.disabled === 0) {
    return `${summary.total} enabled`;
  }
  if (summary.enabled === 0) {
    return `${summary.total} disabled`;
  }
  return `${summary.enabled} enabled · ${summary.disabled} disabled`;
}

function formatLocalState(state: State, changed: boolean): string {
  return `${state}${changed ? " · unsaved" : ""}`;
}

export function formatUnifiedItemLabel(
  item: UnifiedItem,
  state: State | undefined,
  theme: Theme,
  changed = false
): string {
  if (item.type === "local") {
    const currentState = state ?? item.state;
    const status = getStatusIcon(theme, currentState);
    const name = theme.bold(item.displayName);
    const meta = theme.fg(
      changed ? "warning" : "muted",
      `local · ${item.scope} · ${formatLocalState(currentState, changed)}`
    );
    return `${status} ${name}  ${meta}`;
  }

  const sourceKind = getPackageSourceKind(item.source);
  const status = getPackageExtensionStatusIcon(theme, item.extensionSummary);
  const name = theme.bold(item.displayName);
  const version = item.version ? theme.fg("dim", `@${item.version}`) : "";
  const details = [
    sourceKind === "unknown" ? "package" : sourceKind,
    item.scope,
    formatPackageExtensionState(item.extensionSummary),
    item.size !== undefined ? formatBytes(item.size) : undefined,
    item.updateAvailable ? "update available" : undefined,
  ].filter(Boolean);
  const tone = item.updateAvailable ? "warning" : "muted";
  return `${status} ${name}${version}  ${theme.fg(tone, details.join(" · "))}`;
}

export function formatUnifiedItemDescription(
  item: UnifiedItem,
  state: State | undefined,
  changed: boolean,
  cwd: string
): string {
  if (item.type === "local") {
    const currentState = state ?? item.state;
    return [
      item.summary || "No description",
      `local · ${item.scope} · ${formatLocalState(currentState, changed)}`,
      compactDisplayPath(getLocalItemCurrentPath(item, state), cwd),
    ].join(" • ");
  }

  const sourceKind = getPackageSourceKind(item.source);
  const source = sourceKind === "local" ? compactDisplayPath(item.source, cwd) : item.source;
  return [
    item.description || "No description",
    `${sourceKind === "unknown" ? "package" : sourceKind} · ${item.scope}`,
    formatPackageExtensionState(item.extensionSummary),
    item.updateAvailable ? "update available" : undefined,
    item.size !== undefined ? formatBytes(item.size) : undefined,
    source,
  ]
    .filter(Boolean)
    .join(" • ");
}

export function compactDisplayPath(filePath: string, cwd: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedHome = homedir().replace(/\\/g, "/");

  if (normalizedPath === normalizedHome) return "~";
  if (normalizedPath.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedPath.slice(normalizedHome.length + 1)}`;
  }

  const relativePath = relative(cwd, filePath).replace(/\\/g, "/");
  if (
    relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !isAbsoluteDisplayPath(relativePath)
  ) {
    return `./${relativePath}`;
  }

  return normalizedPath;
}

function isAbsoluteDisplayPath(value: string): boolean {
  return /^([a-zA-Z]:\/|\/|\\\\)/.test(value);
}
