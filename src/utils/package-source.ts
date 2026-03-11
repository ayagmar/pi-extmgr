/**
 * Package source parsing helpers shared across discovery/management flows.
 */
import { parseNpmSource } from "./format.js";

export type PackageSourceKind = "npm" | "git" | "local" | "unknown";

function sanitizeSource(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

export function getPackageSourceKind(source: string): PackageSourceKind {
  const normalized = sanitizeSource(source);

  if (normalized.startsWith("npm:")) return "npm";

  if (
    normalized.startsWith("git:") ||
    normalized.startsWith("git+http://") ||
    normalized.startsWith("git+https://") ||
    normalized.startsWith("git+ssh://") ||
    normalized.startsWith("git+git://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("ssh://") ||
    /^git@[^\s:]+:.+/.test(normalized)
  ) {
    return "git";
  }

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith(".\\") ||
    normalized.startsWith("..\\") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("file://") ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.startsWith("\\\\")
  ) {
    return "local";
  }

  return "unknown";
}

export function normalizeLocalSourceIdentity(source: string): string {
  const normalized = source.replace(/\\/g, "/");
  const looksWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") || source.includes("\\");

  return looksWindowsPath ? normalized.toLowerCase() : normalized;
}

export function normalizePackageIdentity(
  source: string,
  options?: { resolvedPath?: string }
): string {
  const normalized = sanitizeSource(source);
  const kind = getPackageSourceKind(normalized);

  if (kind === "npm") {
    const npm = parseNpmSource(normalized);
    return `npm:${(npm?.name ?? normalized).toLowerCase()}`;
  }

  if (kind === "git") {
    const gitSpec = normalized.startsWith("git:") ? normalized.slice(4) : normalized;
    const { repo } = splitGitRepoAndRef(gitSpec);
    return `git:${repo.replace(/\\/g, "/").toLowerCase()}`;
  }

  if (kind === "local") {
    return `local:${normalizeLocalSourceIdentity(options?.resolvedPath ?? normalized)}`;
  }

  return `raw:${normalized.replace(/\\/g, "/").toLowerCase()}`;
}

export function splitGitRepoAndRef(gitSpec: string): { repo: string; ref?: string | undefined } {
  const lastAt = gitSpec.lastIndexOf("@");
  if (lastAt <= 0) {
    return { repo: gitSpec };
  }

  const tail = gitSpec.slice(lastAt + 1);
  // Refs don't contain path separators or URL separators.
  if (!tail || tail.includes("/") || tail.includes(":")) {
    return { repo: gitSpec };
  }

  return { repo: gitSpec.slice(0, lastAt), ref: tail };
}
