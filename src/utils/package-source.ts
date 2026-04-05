/**
 * Package source parsing helpers shared across discovery/management flows.
 */
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNpmSource } from "./format.js";
import { normalizePathIdentity } from "./path-identity.js";

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
  return normalizePathIdentity(source);
}

export function stripGitSourcePrefix(source: string): string {
  const withoutGitPlus = source.startsWith("git+") ? source.slice(4) : source;
  return withoutGitPlus.startsWith("git:") ? withoutGitPlus.slice(4) : withoutGitPlus;
}

function resolveLocalSourceForIdentity(source: string, cwd?: string): string {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }

  if (source.startsWith("~/")) {
    return join(homedir(), source.slice(2));
  }

  if (
    cwd &&
    (source.startsWith("./") ||
      source.startsWith("../") ||
      source.startsWith(".\\") ||
      source.startsWith("..\\"))
  ) {
    return resolvePath(cwd, source);
  }

  return source;
}

export function normalizePackageIdentity(
  source: string,
  options?: { resolvedPath?: string; cwd?: string }
): string {
  const normalized = sanitizeSource(source);
  const kind = getPackageSourceKind(normalized);

  if (kind === "npm") {
    const npm = parseNpmSource(normalized);
    return `npm:${(npm?.name ?? normalized).toLowerCase()}`;
  }

  if (kind === "git") {
    const gitSpec = stripGitSourcePrefix(normalized);
    const { repo } = splitGitRepoAndRef(gitSpec);
    return `git:${repo.replace(/\\/g, "/").toLowerCase()}`;
  }

  if (kind === "local") {
    const localSource =
      options?.resolvedPath ?? resolveLocalSourceForIdentity(normalized, options?.cwd);
    return `local:${normalizeLocalSourceIdentity(localSource)}`;
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

function extractGitPackageName(repoSpec: string): string {
  if (repoSpec.startsWith("git@")) {
    const afterColon = repoSpec.split(":").slice(1).join(":");
    if (afterColon) {
      const last = afterColon.split("/").pop() || afterColon;
      return last.replace(/\.git$/i, "") || repoSpec;
    }
  }

  try {
    const url = new URL(repoSpec);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last) {
      return last.replace(/\.git$/i, "") || repoSpec;
    }
  } catch {
    // Fall back to generic path splitting below.
  }

  const last = repoSpec.split(/[/:]/).filter(Boolean).pop();
  return (last ? last.replace(/\.git$/i, "") : repoSpec) || repoSpec;
}

export function parsePackageNameAndVersion(fullSource: string): {
  name: string;
  version?: string | undefined;
} {
  const parsedNpm = parseNpmSource(fullSource);
  if (parsedNpm) {
    return parsedNpm;
  }

  const sourceKind = getPackageSourceKind(fullSource);
  if (sourceKind === "git") {
    const gitSpec = stripGitSourcePrefix(fullSource);
    const { repo } = splitGitRepoAndRef(gitSpec);
    return { name: extractGitPackageName(repo) };
  }

  if (fullSource.includes("node_modules/")) {
    const nmMatch = fullSource.match(/node_modules\/(.+)$/);
    if (nmMatch?.[1]) {
      return { name: nmMatch[1] };
    }
  }

  const pathParts = fullSource.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1];
  return { name: fileName || fullSource };
}
