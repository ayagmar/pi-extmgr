/**
 * Extension change history tracking using pi.appendEntry()
 * This persists extension management actions to the session
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChangeAction =
  | "extension_toggle"
  | "package_install"
  | "package_update"
  | "package_remove"
  | "cache_clear";

export interface ExtensionChangeEntry {
  action: ChangeAction;
  timestamp: number;
  // Extension toggle fields
  extensionId?: string | undefined;
  fromState?: "enabled" | "disabled" | undefined;
  toState?: "enabled" | "disabled" | undefined;
  // Package fields
  packageSource?: string | undefined;
  packageName?: string | undefined;
  version?: string | undefined;
  scope?: "global" | "project" | undefined;
  // Result
  success: boolean;
  error?: string | undefined;
}

export interface HistoryFilters {
  limit?: number;
  action?: ChangeAction;
  success?: boolean;
  packageQuery?: string;
  sinceTimestamp?: number;
}

export interface GlobalHistoryEntry {
  change: ExtensionChangeEntry;
  sessionFile: string;
}

const EXT_CHANGE_CUSTOM_TYPE = "extmgr-change";
const DEFAULT_SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * Log an extension change to the session
 */
export function logChange(pi: ExtensionAPI, change: Omit<ExtensionChangeEntry, "timestamp">): void {
  const entry: ExtensionChangeEntry = {
    ...change,
    timestamp: Date.now(),
  };

  pi.appendEntry(EXT_CHANGE_CUSTOM_TYPE, entry);
}

/**
 * Log extension state toggle
 */
export function logExtensionToggle(
  pi: ExtensionAPI,
  extensionId: string,
  fromState: "enabled" | "disabled",
  toState: "enabled" | "disabled",
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "extension_toggle",
    extensionId,
    fromState,
    toState,
    success,
    error,
  });
}

/**
 * Log package installation
 */
export function logPackageInstall(
  pi: ExtensionAPI,
  source: string,
  name: string,
  version: string | undefined,
  scope: "global" | "project",
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_install",
    packageSource: source,
    packageName: name,
    version,
    scope,
    success,
    error,
  });
}

/**
 * Log package update
 */
export function logPackageUpdate(
  pi: ExtensionAPI,
  source: string,
  name: string,
  toVersion: string | undefined,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_update",
    packageSource: source,
    packageName: name,
    version: toVersion,
    scope: source.includes("node_modules") ? "global" : "project",
    success,
    error,
  });
}

/**
 * Log package removal
 */
export function logPackageRemove(
  pi: ExtensionAPI,
  source: string,
  name: string,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_remove",
    packageSource: source,
    packageName: name,
    success,
    error,
  });
}

/**
 * Log cache clear operation
 */
export function logCacheClear(pi: ExtensionAPI, success: boolean, error?: string): void {
  logChange(pi, {
    action: "cache_clear",
    success,
    error,
  });
}

function isExtensionChangeEntry(value: unknown): value is ExtensionChangeEntry {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ExtensionChangeEntry>;
  if (typeof maybe.action !== "string") return false;
  if (typeof maybe.timestamp !== "number") return false;
  if (typeof maybe.success !== "boolean") return false;

  return true;
}

function asChangeEntry(data: unknown): ExtensionChangeEntry | undefined {
  return isExtensionChangeEntry(data) ? data : undefined;
}

function matchesHistoryFilters(change: ExtensionChangeEntry, filters: HistoryFilters): boolean {
  const packageQuery = filters.packageQuery?.toLowerCase().trim();

  if (filters.action && change.action !== filters.action) return false;
  if (typeof filters.success === "boolean" && change.success !== filters.success) return false;
  if (filters.sinceTimestamp && change.timestamp < filters.sinceTimestamp) return false;

  if (packageQuery) {
    const packageName = change.packageName?.toLowerCase() ?? "";
    const packageSource = change.packageSource?.toLowerCase() ?? "";
    const extensionId = change.extensionId?.toLowerCase() ?? "";
    if (
      !packageName.includes(packageQuery) &&
      !packageSource.includes(packageQuery) &&
      !extensionId.includes(packageQuery)
    ) {
      return false;
    }
  }

  return true;
}

function applyHistoryLimit<T>(entries: T[], filters: HistoryFilters = {}): T[] {
  const limit = filters.limit ?? 20;
  if (limit <= 0) {
    return entries;
  }
  return entries.slice(-limit);
}

function applyHistoryFilters(
  changes: ExtensionChangeEntry[],
  filters: HistoryFilters = {}
): ExtensionChangeEntry[] {
  return applyHistoryLimit(
    changes.filter((change) => matchesHistoryFilters(change, filters)),
    filters
  );
}

function getAllSessionChanges(ctx: ExtensionCommandContext): ExtensionChangeEntry[] {
  const entries = ctx.sessionManager.getEntries();
  const changes: ExtensionChangeEntry[] = [];

  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== EXT_CHANGE_CUSTOM_TYPE || !entry.data) {
      continue;
    }

    const change = asChangeEntry(entry.data);
    if (change) {
      changes.push(change);
    }
  }

  return changes;
}

/**
 * Get filtered changes from the current session
 */
export function querySessionChanges(
  ctx: ExtensionCommandContext,
  filters: HistoryFilters = {}
): ExtensionChangeEntry[] {
  return applyHistoryFilters(getAllSessionChanges(ctx), filters);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function walkSessionFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkSessionFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push(fullPath);
    }
  }

  return result;
}

/**
 * Query change history across all persisted pi sessions.
 */
export async function queryGlobalHistory(
  filters: HistoryFilters = {},
  sessionDir = DEFAULT_SESSION_DIR
): Promise<GlobalHistoryEntry[]> {
  const files = await walkSessionFiles(sessionDir);
  const all: GlobalHistoryEntry[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      if (!isRecord(parsed)) continue;

      if (
        parsed.type !== "custom" ||
        parsed.customType !== EXT_CHANGE_CUSTOM_TYPE ||
        !parsed.data
      ) {
        continue;
      }

      const change = asChangeEntry(parsed.data);
      if (change) {
        all.push({ change, sessionFile: file });
      }
    }
  }

  all.sort((a, b) => a.change.timestamp - b.change.timestamp);

  const filtered = all.filter((entry) => matchesHistoryFilters(entry.change, filters));
  return applyHistoryLimit(filtered, filters);
}

/**
 * Format a change entry for display
 */
export function formatChangeEntry(entry: ExtensionChangeEntry): string {
  const time = new Date(entry.timestamp).toLocaleString();
  const icon = entry.success ? "✓" : "✗";
  const packageLabel = entry.packageName ?? entry.packageSource ?? "unknown";
  const sourceSuffix =
    entry.packageSource && entry.packageSource !== entry.packageName
      ? ` (${entry.packageSource})`
      : "";

  switch (entry.action) {
    case "extension_toggle":
      return `[${time}] ${icon} ${entry.extensionId}: ${entry.fromState} → ${entry.toState}`;

    case "package_install":
      return `[${time}] ${icon} Installed ${packageLabel}${entry.version ? `@${entry.version}` : ""}${sourceSuffix}`;

    case "package_update":
      return `[${time}] ${icon} Updated ${packageLabel}${entry.version ? ` → @${entry.version}` : ""}${sourceSuffix}`;

    case "package_remove":
      return `[${time}] ${icon} Removed ${packageLabel}${sourceSuffix}`;

    case "cache_clear":
      return `[${time}] ${icon} Cache cleared`;

    default:
      return `[${time}] ${icon} Unknown action`;
  }
}
