/**
 * Extension change history tracking using pi.appendEntry()
 * This persists extension management actions to the session
 */

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type ChangeAction =
  | "extension_toggle"
  | "extension_delete"
  | "package_install"
  | "package_update"
  | "package_remove"
  | "cache_clear"
  | "auto_update_config";

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
  detail?: string | undefined;
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

export function logExtensionDelete(
  pi: ExtensionAPI,
  extensionId: string,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "extension_delete",
    extensionId,
    success,
    error,
  });
}

export function logAutoUpdateConfig(
  pi: ExtensionAPI,
  detail: string,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "auto_update_config",
    detail,
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
    const detail = change.detail?.toLowerCase() ?? "";
    if (
      !packageName.includes(packageQuery) &&
      !packageSource.includes(packageQuery) &&
      !extensionId.includes(packageQuery) &&
      !detail.includes(packageQuery)
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

/** Return a chronological activity timeline for one package. */
export function queryPackageTimeline(
  ctx: ExtensionCommandContext,
  packageQuery: string,
  options: Omit<HistoryFilters, "packageQuery"> = {}
): ExtensionChangeEntry[] {
  return querySessionChanges(ctx, { ...options, packageQuery }).sort(
    (left, right) => left.timestamp - right.timestamp
  );
}

function pushGlobalHistoryEntry(
  entries: GlobalHistoryEntry[],
  nextEntry: GlobalHistoryEntry,
  limit: number | undefined
): void {
  if (!limit || limit <= 0) {
    entries.push(nextEntry);
    return;
  }

  if (entries.length < limit) {
    entries.push(nextEntry);
    return;
  }

  let oldestIndex = 0;
  let oldestEntry = entries[oldestIndex];
  if (!oldestEntry) {
    entries.push(nextEntry);
    return;
  }

  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index];
    if (entry && entry.change.timestamp < oldestEntry.change.timestamp) {
      oldestIndex = index;
      oldestEntry = entry;
    }
  }

  if (oldestEntry.change.timestamp <= nextEntry.change.timestamp) {
    entries[oldestIndex] = nextEntry;
  }
}

/**
 * Query change history across all persisted pi sessions.
 */
export async function queryGlobalHistory(
  filters: HistoryFilters = {},
  sessionDir?: string
): Promise<GlobalHistoryEntry[]> {
  const matchedEntries: GlobalHistoryEntry[] = [];
  const limit = filters.limit ?? 20;
  let sessions: Awaited<ReturnType<typeof SessionManager.listAll>>;
  try {
    sessions = sessionDir
      ? await SessionManager.listAll(sessionDir)
      : await SessionManager.listAll();
  } catch {
    return matchedEntries;
  }

  for (const session of sessions) {
    let entries: ReturnType<ReturnType<typeof SessionManager.open>["getEntries"]>;
    try {
      entries = SessionManager.open(session.path, sessionDir).getEntries();
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== EXT_CHANGE_CUSTOM_TYPE) continue;
      const change = asChangeEntry(entry.data);
      if (!change || !matchesHistoryFilters(change, filters)) continue;
      pushGlobalHistoryEntry(matchedEntries, { change, sessionFile: session.path }, limit);
    }
  }

  matchedEntries.sort((a, b) => a.change.timestamp - b.change.timestamp);
  return matchedEntries;
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

    case "extension_delete":
      return `[${time}] ${icon} Deleted ${entry.extensionId ?? "extension"}`;

    case "package_install":
      return `[${time}] ${icon} Installed ${packageLabel}${entry.version ? `@${entry.version}` : ""}${sourceSuffix}`;

    case "package_update":
      return `[${time}] ${icon} Updated ${packageLabel}${entry.version ? ` → @${entry.version}` : ""}${sourceSuffix}`;

    case "package_remove":
      return `[${time}] ${icon} Removed ${packageLabel}${sourceSuffix}`;

    case "cache_clear":
      return `[${time}] ${icon} Cache cleared`;

    case "auto_update_config":
      return `[${time}] ${icon} Scheduled update checks ${entry.detail ?? "configuration changed"}`;

    default:
      return `[${time}] ${icon} Unknown action`;
  }
}
