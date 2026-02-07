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
  type AutoUpdateConfig,
} from "./settings.js";

// Global timer reference (module-level singleton)
let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start auto-update background checker
 */
export function startAutoUpdateTimer(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  onUpdateAvailable?: (packages: string[]) => void
): void {
  // Clear existing timer
  stopAutoUpdateTimer();

  const config = getAutoUpdateConfig(ctx);
  if (!config.enabled || config.intervalMs === 0) {
    return;
  }

  const interval = getScheduleInterval(config);
  if (!interval) return;

  // Check immediately if it's time
  void checkForUpdates(pi, ctx, onUpdateAvailable);

  // Set up interval
  autoUpdateTimer = setInterval(() => {
    void checkForUpdates(pi, ctx, onUpdateAvailable);
  }, interval);

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
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

/**
 * Check if auto-update timer is running
 */
export function isAutoUpdateRunning(): boolean {
  return autoUpdateTimer !== null;
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
  const pkgName = pkg.source.slice(4).split("@")[0];
  if (!pkgName) return false;

  try {
    const res = await pi.exec("npm", ["view", pkgName, "version", "--json"], {
      timeout: 10000,
      cwd: ctx.cwd,
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
  };

  saveAutoUpdateConfig(pi, config);
  startAutoUpdateTimer(pi, ctx, onUpdateAvailable);

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
  });

  notify(ctx, "Auto-update disabled", "info");
}
