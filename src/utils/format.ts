/**
 * Formatting utilities
 */
import type { ExtensionEntry, InstalledPackage } from "../types/index.js";

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Get the terminal width, with a minimum fallback
 */
export function getTerminalWidth(minWidth = 80): number {
  return Math.max(minWidth, process.stdout.columns || minWidth);
}

/**
 * Calculate available space for description based on fixed-width elements
 */
export function getDescriptionWidth(
  totalWidth: number,
  reservedSpace: number,
  minDescWidth = 20
): number {
  return Math.max(minDescWidth, totalWidth - reservedSpace);
}

/**
 * Dynamic truncate that adapts to available terminal width
 * @param text - Text to truncate
 * @param reservedSpace - Space taken by fixed elements (icons, name, version, etc.)
 * @param minWidth - Minimum terminal width to consider
 */
export function dynamicTruncate(text: string, reservedSpace: number, minWidth = 80): string {
  const termWidth = getTerminalWidth(minWidth);
  const maxDescWidth = getDescriptionWidth(termWidth, reservedSpace);
  return truncate(text, maxDescWidth);
}

export function formatEntry(entry: ExtensionEntry): string {
  const state = entry.state === "enabled" ? "on " : "off";
  const scope = entry.scope === "global" ? "G" : "P";
  return `[${state}] [${scope}] ${entry.displayName} - ${entry.summary}`;
}

export function formatInstalledPackageLabel(pkg: InstalledPackage, index?: number): string {
  const base = `${pkg.name}${pkg.version ? ` @${pkg.version}` : ""} (${pkg.scope})`;
  return index !== undefined ? `[${index + 1}] ${base}` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const GIT_PATTERNS = {
  gitPrefix: /^git:/,
  httpPrefix: /^https?:\/\//,
  sshPrefix: /^ssh:\/\//,
  gitProtoPrefix: /^git:\/\//,
  gitSsh: /^git@[^\s:]+:.+/,
} as const;

const LOCAL_PATH_PATTERNS = {
  unixAbsolute: /^\//,
  unixRelative: /^\.\.?\//,
  windowsRelative: /^\.\.?\\/,
  homeRelative: /^~\//,
  fileProto: /^file:\/\//,
  windowsDrive: /^[a-zA-Z]:[\\/]/,
  uncPath: /^\\\\/,
} as const;

function isGitLikeSource(source: string): boolean {
  return (
    GIT_PATTERNS.gitPrefix.test(source) ||
    GIT_PATTERNS.httpPrefix.test(source) ||
    GIT_PATTERNS.sshPrefix.test(source) ||
    GIT_PATTERNS.gitProtoPrefix.test(source) ||
    GIT_PATTERNS.gitSsh.test(source)
  );
}

function isLocalPathSource(source: string): boolean {
  return (
    LOCAL_PATH_PATTERNS.unixAbsolute.test(source) ||
    LOCAL_PATH_PATTERNS.unixRelative.test(source) ||
    LOCAL_PATH_PATTERNS.windowsRelative.test(source) ||
    LOCAL_PATH_PATTERNS.homeRelative.test(source) ||
    LOCAL_PATH_PATTERNS.fileProto.test(source) ||
    LOCAL_PATH_PATTERNS.windowsDrive.test(source) ||
    LOCAL_PATH_PATTERNS.uncPath.test(source)
  );
}

export function isPackageSource(str: string): boolean {
  const source = str.trim();
  if (!source) return false;

  return source.startsWith("npm:") || isGitLikeSource(source) || isLocalPathSource(source);
}

export function normalizePackageSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return trimmed;

  if (GIT_PATTERNS.gitSsh.test(trimmed)) {
    return `git:${trimmed}`;
  }

  if (isPackageSource(trimmed)) {
    return trimmed;
  }

  return `npm:${trimmed}`;
}

export function parseNpmSource(
  source: string
): { name: string; version?: string | undefined } | undefined {
  if (!source.startsWith("npm:")) return undefined;

  const spec = source.slice(4).trim();
  if (!spec) return undefined;

  // npm:@scope/name@1.2.3 -> name=@scope/name, version=1.2.3
  // npm:package@1.2.3     -> name=package, version=1.2.3
  const separatorIndex = spec.lastIndexOf("@");

  // Scoped package without version starts with '@' but has no second '@'
  if (separatorIndex <= 0) {
    return { name: spec };
  }

  const name = spec.slice(0, separatorIndex);
  const version = spec.slice(separatorIndex + 1);

  if (!name) return undefined;
  if (!version) return { name };

  return { name, version };
}
