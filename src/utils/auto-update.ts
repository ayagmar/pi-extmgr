/**
 * Auto-update logic and background checker
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { InstalledPackage } from "../types/index.js";
import { getInstalledPackages } from "../packages/discovery.js";
import { notify } from "./notify.js";
import {
  getAutoUpdateConfig,
  saveAutoUpdateConfig,
  getScheduleInterval,
  calculateNextCheck,
  parseDuration,
  type AutoUpdateConfig,
} from "./settings.js";
import { parseNpmSource } from "./format.js";
import { execNpm } from "./npm-exec.js";
import { TIMEOUTS } from "../constants.js";

import { startTimer, stopTimer, isTimerRunning } from "./timer.js";

// Context provider for safe session handling
export type ContextProvider = () => (ExtensionCommandContext | ExtensionContext) | undefined;

/**
 * Start auto-update background checker
 * Uses a context provider to avoid stale context issues when sessions switch
 */
export function startAutoUpdateTimer(
  pi: ExtensionAPI,
  getCtx: ContextProvider,
  onUpdateAvailable?: (packages: string[]) => void
): void {
  stopAutoUpdateTimer();

  const ctx = getCtx();
  if (!ctx) return;

  const config = getAutoUpdateConfig(ctx);
  if (!config.enabled || config.intervalMs === 0) {
    return;
  }

  const interval = getScheduleInterval(config);
  if (!interval) return;

  // Run an initial check immediately.
  const initialCtx = getCtx();
  if (initialCtx) {
    void checkForUpdates(pi, initialCtx, onUpdateAvailable);
  }

  // Set up recurring checks
  startTimer(interval, () => {
    const checkCtx = getCtx();
    if (!checkCtx) {
      stopAutoUpdateTimer();
      return;
    }
    void checkForUpdates(pi, checkCtx, onUpdateAvailable);
  });

  // Persist that timer is running
  saveAutoUpdateConfig(pi, {
    ...config,
    nextCheck: calculateNextCheck(config.intervalMs),
  });
}

/**
 * Stop auto-update background checker
 */
export function stopAutoUpdateTimer(): void {
  stopTimer();
}

/**
 * Check if auto-update timer is running
 */
export function isAutoUpdateRunning(): boolean {
  return isTimerRunning();
}

/**
 * Check for available updates
 * Returns list of packages with updates available
 */
export async function checkForUpdates(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  onUpdateAvailable?: (packages: string[]) => void
): Promise<string[]> {
  const packages = await getInstalledPackages(ctx, pi);
  const npmPackages = packages.filter((p) => p.source.startsWith("npm:"));

  const updatesAvailable: string[] = [];

  for (const pkg of npmPackages) {
    const hasUpdate = await checkPackageUpdate(pkg, ctx, pi);
    if (hasUpdate) {
      updatesAvailable.push(pkg.name);
    }
  }

  // Update last check time
  const config = getAutoUpdateConfig(ctx);
  saveAutoUpdateConfig(pi, {
    ...config,
    lastCheck: Date.now(),
    nextCheck: calculateNextCheck(config.intervalMs),
    updatesAvailable,
  });

  if (updatesAvailable.length > 0 && onUpdateAvailable) {
    onUpdateAvailable(updatesAvailable);
  }

  return updatesAvailable;
}

/**
 * Check if a specific package has updates available
 */
async function checkPackageUpdate(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<boolean> {
  const parsed = parseNpmSource(pkg.source);
  const pkgName = parsed?.name;
  if (!pkgName) return false;

  try {
    const res = await execNpm(pi, ["view", pkgName, "version", "--json"], ctx, {
      timeout: TIMEOUTS.npmView,
    });

    if (res.code !== 0) return false;

    const latestVersion = JSON.parse(res.stdout) as string;
    const currentVersion = pkg.version;

    if (!currentVersion) return false;

    // Simple version comparison (assumes semver)
    return latestVersion !== currentVersion;
  } catch {
    return false;
  }
}

/**
 * Get status text for display
 */
export function getAutoUpdateStatus(ctx: ExtensionCommandContext | ExtensionContext): string {
  const config = getAutoUpdateConfig(ctx);

  if (!config.enabled || config.intervalMs === 0) {
    return "⏸ auto-update off";
  }

  const indicator = isAutoUpdateRunning() ? "↻" : "⏸";
  return `${indicator} ${config.displayText}`;
}

/**
 * Return package names currently known to have updates available
 * (from the latest background check).
 */
export function getKnownUpdates(ctx: ExtensionCommandContext | ExtensionContext): Set<string> {
  const config = getAutoUpdateConfig(ctx);
  return new Set(config.updatesAvailable ?? []);
}

/**
 * Interactive wizard to configure auto-update frequency.
 */
export async function promptAutoUpdateWizard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  onUpdateAvailable?: (packages: string[]) => void
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Auto-update wizard requires interactive mode.", "warning");
    return;
  }

  const current = getAutoUpdateConfig(ctx);
  const choice = await ctx.ui.select(`Auto-update (${current.displayText})`, [
    "Off",
    "Every hour",
    "Daily",
    "Weekly",
    "Custom...",
    "Cancel",
  ]);

  if (!choice || choice === "Cancel") return;

  if (choice === "Off") {
    disableAutoUpdate(pi, ctx);
    return;
  }

  if (choice === "Every hour") {
    enableAutoUpdate(pi, ctx, 60 * 60 * 1000, "1 hour", onUpdateAvailable);
    return;
  }

  if (choice === "Daily") {
    enableAutoUpdate(pi, ctx, 24 * 60 * 60 * 1000, "daily", onUpdateAvailable);
    return;
  }

  if (choice === "Weekly") {
    enableAutoUpdate(pi, ctx, 7 * 24 * 60 * 60 * 1000, "weekly", onUpdateAvailable);
    return;
  }

  const input = await ctx.ui.input("Auto-update interval", current.displayText || "1d");
  if (!input?.trim()) return;

  const parsed = parseDuration(input.trim());
  if (!parsed) {
    notify(ctx, "Invalid duration. Examples: 1h, 1d, 1w, 1m, never", "warning");
    return;
  }

  if (parsed.ms === 0) {
    disableAutoUpdate(pi, ctx);
  } else {
    enableAutoUpdate(pi, ctx, parsed.ms, parsed.display, onUpdateAvailable);
  }
}

/**
 * Enable auto-update with specified interval
 */
export function enableAutoUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  intervalMs: number,
  displayText: string,
  onUpdateAvailable?: (packages: string[]) => void
): void {
  const config: AutoUpdateConfig = {
    intervalMs,
    enabled: true,
    displayText,
    lastCheck: Date.now(),
    nextCheck: calculateNextCheck(intervalMs),
    updatesAvailable: [],
  };

  saveAutoUpdateConfig(pi, config);

  const getCtx: ContextProvider = () => ctx;

  startAutoUpdateTimer(pi, getCtx, onUpdateAvailable);

  notify(ctx, `Auto-update enabled: ${displayText}`, "info");
}

/**
 * Disable auto-update
 */
export function disableAutoUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext
): void {
  stopAutoUpdateTimer();

  saveAutoUpdateConfig(pi, {
    intervalMs: 0,
    enabled: false,
    displayText: "off",
    updatesAvailable: [],
  });

  notify(ctx, "Auto-update disabled", "info");
}
