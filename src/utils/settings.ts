/**
 * Auto-update settings storage
 * Persists to disk so config survives across pi sessions.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { parseScheduleDuration } from "./duration.js";
import { fileExists } from "./fs.js";
import { normalizePackageIdentity } from "./package-source.js";

export interface AutoUpdateConfig {
  intervalMs: number;
  lastCheck?: number;
  nextCheck?: number;
  enabled: boolean;
  displayText: string; // Human-readable description
  updatesAvailable?: string[];
}

const DEFAULT_CONFIG: AutoUpdateConfig = {
  intervalMs: 0,
  enabled: false,
  displayText: "off",
};

const SETTINGS_KEY = "extmgr-auto-update";
const SETTINGS_DIR = process.env.PI_EXTMGR_CACHE_DIR
  ? process.env.PI_EXTMGR_CACHE_DIR
  : join(homedir(), ".pi", "agent", ".extmgr-cache");
const SETTINGS_FILE = join(SETTINGS_DIR, "auto-update.json");

let settingsWriteQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!isValidStringArray(value)) return undefined;
  const sanitized = value.map((s) => s.trim()).filter(Boolean);
  return sanitized.length > 0 ? sanitized : undefined;
}

function isUpdateIdentity(value: string): boolean {
  return /^(npm|git|local|raw):/i.test(value);
}

function sanitizeUpdateIdentities(value: unknown): string[] | undefined {
  const updates = sanitizeStringArray(value);
  if (!updates) return undefined;

  const sanitized = updates
    .filter(isUpdateIdentity)
    .map((entry) => normalizePackageIdentity(entry));
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeAutoUpdateConfig(input: unknown): AutoUpdateConfig {
  if (!isRecord(input)) {
    return { ...DEFAULT_CONFIG };
  }

  const config: AutoUpdateConfig = { ...DEFAULT_CONFIG };

  const intervalMs = input.intervalMs;
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs >= 0) {
    config.intervalMs = Math.floor(intervalMs);
  }

  if (typeof input.enabled === "boolean") {
    config.enabled = input.enabled;
  }

  if (typeof input.displayText === "string" && input.displayText.trim()) {
    config.displayText = input.displayText.trim();
  }

  if (
    typeof input.lastCheck === "number" &&
    Number.isFinite(input.lastCheck) &&
    input.lastCheck >= 0
  ) {
    config.lastCheck = input.lastCheck;
  }

  if (
    typeof input.nextCheck === "number" &&
    Number.isFinite(input.nextCheck) &&
    input.nextCheck >= 0
  ) {
    config.nextCheck = input.nextCheck;
  }

  const updates = sanitizeUpdateIdentities(input.updatesAvailable);
  if (updates) {
    config.updatesAvailable = updates;
  }

  if (!config.enabled || config.intervalMs === 0) {
    config.enabled = false;
    config.intervalMs = 0;
    config.displayText = "off";
  }

  return config;
}

function getSessionConfig(
  ctx: ExtensionCommandContext | ExtensionContext
): AutoUpdateConfig | undefined {
  const entries =
    typeof ctx.sessionManager.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === SETTINGS_KEY && entry.data) {
      return sanitizeAutoUpdateConfig(entry.data);
    }
  }

  return undefined;
}

/**
 * Ensures the settings directory exists
 */
async function ensureSettingsDir(): Promise<void> {
  try {
    await mkdir(SETTINGS_DIR, { recursive: true });
  } catch (error) {
    console.warn("[extmgr] Failed to create settings directory:", error);
  }
}

async function backupCorruptSettingsFile(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(SETTINGS_DIR, `auto-update.invalid-${stamp}.json`);

  try {
    await rename(SETTINGS_FILE, backupPath);
    console.warn(
      `[extmgr] Invalid auto-update settings JSON. Backed up to ${backupPath} and reset to defaults.`
    );
  } catch (error) {
    console.warn("[extmgr] Failed to backup invalid auto-update settings file:", error);
  }
}

/**
 * Reads config from disk asynchronously
 */
async function readConfigFromDisk(): Promise<AutoUpdateConfig | undefined> {
  try {
    if (!(await fileExists(SETTINGS_FILE))) {
      return undefined;
    }

    const raw = await readFile(SETTINGS_FILE, "utf8");
    if (!raw.trim()) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return sanitizeAutoUpdateConfig(parsed);
    } catch {
      await backupCorruptSettingsFile();
      return undefined;
    }
  } catch (error) {
    console.warn("[extmgr] Failed to read settings:", error);
    return undefined;
  }
}

/**
 * Writes config to disk asynchronously (serialized + best-effort atomic)
 */
async function writeConfigToDisk(config: AutoUpdateConfig): Promise<void> {
  await ensureSettingsDir();

  const content = `${JSON.stringify(config, null, 2)}\n`;
  const tmpPath = join(SETTINGS_DIR, `auto-update.${process.pid}.${Date.now()}.tmp`);

  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, SETTINGS_FILE);
  } catch {
    // Fallback for filesystems where rename-overwrite can fail.
    await writeFile(SETTINGS_FILE, content, "utf8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function enqueueConfigWrite(config: AutoUpdateConfig): void {
  settingsWriteQueue = settingsWriteQueue
    .then(() => writeConfigToDisk(config))
    .catch((error) => {
      console.warn("[extmgr] Failed to write settings:", error);
    });
}

/**
 * Hydrate session state from persisted disk settings.
 * This ensures sync reads can still work after startup/session switch.
 */
export async function hydrateAutoUpdateConfig(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext
): Promise<AutoUpdateConfig> {
  const fromSession = getSessionConfig(ctx);
  if (fromSession) return fromSession;

  const fromDisk = await readConfigFromDisk();
  const config = fromDisk ?? { ...DEFAULT_CONFIG };

  pi.appendEntry(SETTINGS_KEY, config);
  return config;
}

/**
 * Get auto-update config.
 * Priority:
 *  1) latest value in current session branch entries
 *  2) persisted value on disk
 *  3) defaults
 */
export async function getAutoUpdateConfigAsync(
  ctx: ExtensionCommandContext | ExtensionContext
): Promise<AutoUpdateConfig> {
  const fromSession = getSessionConfig(ctx);
  if (fromSession) return fromSession;

  const persisted = await readConfigFromDisk();
  if (persisted) return persisted;

  return { ...DEFAULT_CONFIG };
}

/**
 * Synchronous version for contexts where async is not practical.
 * Falls back to defaults if disk read would be required.
 */
export function getAutoUpdateConfig(
  ctx: ExtensionCommandContext | ExtensionContext
): AutoUpdateConfig {
  return getSessionConfig(ctx) ?? { ...DEFAULT_CONFIG };
}

/**
 * Save auto-update config to session + disk.
 */
export function saveAutoUpdateConfig(pi: ExtensionAPI, config: Partial<AutoUpdateConfig>): void {
  const fullConfig = sanitizeAutoUpdateConfig({
    ...DEFAULT_CONFIG,
    ...config,
  });

  pi.appendEntry(SETTINGS_KEY, fullConfig);
  enqueueConfigWrite(fullConfig);
}

/**
 * Clear the updates available list after package mutations.
 * Call this after install/update/remove to prevent stale update notifications.
 */
export function clearUpdatesAvailable(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  identities?: Iterable<string>
): void {
  const config = getAutoUpdateConfig(ctx);
  const currentUpdates = config.updatesAvailable ?? [];
  if (currentUpdates.length === 0) {
    return;
  }

  const clearedIdentities = identities ? new Set(identities) : undefined;
  const updatesAvailable = clearedIdentities
    ? currentUpdates.filter((identity) => !clearedIdentities.has(identity))
    : [];

  if (updatesAvailable.length === currentUpdates.length) {
    return;
  }

  saveAutoUpdateConfig(pi, {
    ...config,
    updatesAvailable,
  });
}

/**
 * Parse schedule duration strings for auto-update settings.
 * Supports hours/days/weeks/months plus schedule aliases like `daily`, `weekly`, and `never`.
 */
export function parseDuration(input: string): { ms: number; display: string } | undefined {
  return parseScheduleDuration(input);
}

/**
 * Get interval in milliseconds
 */
export function getScheduleInterval(config: AutoUpdateConfig): number | undefined {
  if (!config.enabled || config.intervalMs === 0) {
    return undefined;
  }
  return config.intervalMs;
}

/**
 * Calculate next check time
 */
export function calculateNextCheck(intervalMs: number): number {
  return Date.now() + intervalMs;
}
