/**
 * Auto-update settings storage
 * Uses extension state via pi.appendEntry() for persistence
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export interface AutoUpdateConfig {
  intervalMs: number;
  lastCheck?: number;
  nextCheck?: number;
  enabled: boolean;
  displayText: string; // Human-readable description
}

const DEFAULT_CONFIG: AutoUpdateConfig = {
  intervalMs: 0,
  enabled: false,
  displayText: "off",
};

const SETTINGS_KEY = "extmgr-auto-update";

/**
 * Get auto-update config from session
 */
export function getAutoUpdateConfig(
  ctx: ExtensionCommandContext | ExtensionContext
): AutoUpdateConfig {
  const entries = ctx.sessionManager.getEntries();

  // Find most recent config entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === SETTINGS_KEY && entry.data) {
      return { ...DEFAULT_CONFIG, ...(entry.data as AutoUpdateConfig) };
    }
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Save auto-update config to session
 */
export function saveAutoUpdateConfig(pi: ExtensionAPI, config: Partial<AutoUpdateConfig>): void {
  const fullConfig: AutoUpdateConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  pi.appendEntry(SETTINGS_KEY, fullConfig);
}

/**
 * Parse duration string to milliseconds
 * Supports: 1h, 2h, 1d, 7d, 1m, 3m, etc.
 * Also supports: never, off, disable, daily, weekly
 */
export function parseDuration(input: string): { ms: number; display: string } | undefined {
  const normalized = input.toLowerCase().trim();

  // Special cases for disabling
  if (normalized === "never" || normalized === "off" || normalized === "disable") {
    return { ms: 0, display: "off" };
  }

  // Named schedules
  if (normalized === "daily" || normalized === "day" || normalized === "1d") {
    return { ms: 24 * 60 * 60 * 1000, display: "daily" };
  }
  if (normalized === "weekly" || normalized === "week" || normalized === "1w") {
    return { ms: 7 * 24 * 60 * 60 * 1000, display: "weekly" };
  }

  // Parse duration patterns: 1h, 2h, 3d, 7d, 1m, etc.
  const durationMatch = normalized.match(
    /^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months)$/
  );
  if (durationMatch) {
    const value = parseInt(durationMatch[1]!, 10);
    const unit = durationMatch[2]![0]; // First character of unit

    let ms: number;
    let display: string;

    switch (unit) {
      case "h":
        ms = value * 60 * 60 * 1000;
        display = value === 1 ? "1 hour" : `${value} hours`;
        break;
      case "d":
        ms = value * 24 * 60 * 60 * 1000;
        display = value === 1 ? "1 day" : `${value} days`;
        break;
      case "w":
        ms = value * 7 * 24 * 60 * 60 * 1000;
        display = value === 1 ? "1 week" : `${value} weeks`;
        break;
      case "m":
        // Approximate months as 30 days
        ms = value * 30 * 24 * 60 * 60 * 1000;
        display = value === 1 ? "1 month" : `${value} months`;
        break;
      default:
        return undefined;
    }

    return { ms, display };
  }

  return undefined;
}

/**
 * @deprecated Use parseDuration instead
 */
export function parseSchedule(input: string): string | undefined {
  const result = parseDuration(input);
  return result?.display;
}

/**
 * Get human-readable schedule description
 */
export function getScheduleDescription(config: AutoUpdateConfig): string {
  if (!config.enabled || config.intervalMs === 0) {
    return "off";
  }
  return config.displayText;
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
