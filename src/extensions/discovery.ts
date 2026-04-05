/**
 * Local extension discovery
 *
 * This module handles discovery and management of local Pi extensions
 * in both global (~/.pi/agent/extensions) and project (.pi/extensions) scopes.
 */

import { type Dirent } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DISABLED_SUFFIX } from "../constants.js";
import { readPackageManifest } from "../packages/extensions.js";
import { type ExtensionEntry, type Scope, type State } from "../types/index.js";
import { fileExists, readSummary } from "../utils/fs.js";
import {
  normalizeRelativePath,
  resolveRelativePathSelection,
} from "../utils/relative-path-selection.js";

interface RootConfig {
  root: string;
  scope: Scope;
  label: string;
}

/**
 * Discover all local extensions in both global and project scopes.
 *
 * @param cwd - Current working directory for resolving project scope
 * @returns Array of extension entries, sorted alphabetically by display name
 *
 * @example
 * ```typescript
 * const extensions = await discoverExtensions(process.cwd());
 * for (const ext of extensions) {
 *   console.log(`${ext.displayName}: ${ext.state}`);
 * }
 * ```
 */
export async function discoverExtensions(cwd: string): Promise<ExtensionEntry[]> {
  const roots: RootConfig[] = [
    {
      root: join(homedir(), ".pi", "agent", "extensions"),
      scope: "global",
      label: "~/.pi/agent/extensions",
    },
    { root: join(cwd, ".pi", "extensions"), scope: "project", label: ".pi/extensions" },
  ];

  const all: ExtensionEntry[] = [];
  for (const root of roots) {
    all.push(...(await discoverInRoot(root.root, root.scope, root.label)));
  }

  all.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return dedupeExtensions(all);
}

/**
 * Discover extensions in a single root directory.
 *
 * @param root - Directory path to search
 * @param scope - "global" or "project" scope
 * @param label - Display label for this root
 * @returns Array of extension entries found in this root
 */
async function discoverInRoot(
  root: string,
  scope: Scope,
  label: string
): Promise<ExtensionEntry[]> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // Silently ignore ENOENT (directory doesn't exist) - this is expected
    // for project scope when .pi/extensions doesn't exist yet
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Log other errors for debugging
    console.error(`[extensions-manager] Error reading ${root}:`, error);
    return [];
  }

  const found: ExtensionEntry[] = [];

  for (const item of dirEntries) {
    const name = item.name;

    // Skip hidden files and directories (e.g., .temp, .git, etc.)
    if (name.startsWith(".")) continue;

    if (item.isFile()) {
      const entry = await parseTopLevelFile(root, label, scope, name);
      if (entry) found.push(entry);
      continue;
    }

    if (item.isDirectory()) {
      found.push(...(await parseDirectoryExtensions(root, label, scope, name)));
    }
  }

  return found;
}

/**
 * Parse a top-level .ts/.js file as an extension entry.
 *
 * @param root - Root directory path
 * @param label - Display label for the root
 * @param scope - "global" or "project"
 * @param fileName - Name of the file to parse
 * @returns ExtensionEntry if valid, undefined otherwise
 */
async function parseTopLevelFile(
  root: string,
  label: string,
  scope: Scope,
  fileName: string
): Promise<ExtensionEntry | undefined> {
  const isEnabledTsJs = /\.(ts|js)$/i.test(fileName) && !fileName.endsWith(DISABLED_SUFFIX);
  const isDisabledTsJs = /\.(ts|js)\.disabled$/i.test(fileName);

  if (!isEnabledTsJs && !isDisabledTsJs) return undefined;

  const currentPath = join(root, fileName);
  const activePath = isDisabledTsJs ? currentPath.slice(0, -DISABLED_SUFFIX.length) : currentPath;
  const disabledPath = `${activePath}${DISABLED_SUFFIX}`;
  const state: State = isDisabledTsJs ? "disabled" : "enabled";
  const summary = await readSummary(state === "enabled" ? activePath : disabledPath);

  const relativePath = relative(root, activePath).replace(/\.disabled$/i, "");

  return {
    id: `${scope}:${activePath}`,
    scope,
    state,
    activePath,
    disabledPath,
    displayName: `${label}/${relativePath}`,
    summary,
  };
}

function stripDisabledSuffix(path: string): string {
  return path.replace(/\.(ts|js)\.disabled$/i, ".$1");
}

function isExtensionEntrypointPath(path: string): boolean {
  return /\.(ts|js)$/i.test(path);
}

function isLocalExtensionFile(path: string): boolean {
  return /\.(ts|js)(?:\.disabled)?$/i.test(path);
}

async function collectLocalExtensionFiles(rootDir: string, startDir: string): Promise<string[]> {
  const collected: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(startDir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = join(startDir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectLocalExtensionFiles(rootDir, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = normalizeRelativePath(relative(rootDir, absolutePath));
    if (isLocalExtensionFile(relativePath)) {
      collected.push(stripDisabledSuffix(relativePath));
    }
  }

  return collected;
}

async function resolveManifestLocalEntrypoints(dir: string): Promise<string[] | undefined> {
  const manifest = await readPackageManifest(dir);
  const extensions = manifest?.pi?.extensions;
  if (!Array.isArray(extensions)) {
    return undefined;
  }

  const entries = extensions.filter((value): value is string => typeof value === "string");
  const allFiles = await collectLocalExtensionFiles(dir, dir);
  return resolveRelativePathSelection(
    allFiles,
    entries,
    (path, files) => isExtensionEntrypointPath(path) && files.includes(path)
  );
}

async function toDirectoryExtensionEntry(
  root: string,
  label: string,
  scope: Scope,
  dir: string,
  extensionPath: string
): Promise<ExtensionEntry | undefined> {
  const normalizedPath = normalizeRelativePath(extensionPath);
  const activePath = join(dir, normalizedPath);
  const disabledPath = `${activePath}${DISABLED_SUFFIX}`;

  let state: State;
  let summaryPath: string;
  if (await fileExists(activePath)) {
    state = "enabled";
    summaryPath = activePath;
  } else if (await fileExists(disabledPath)) {
    state = "disabled";
    summaryPath = disabledPath;
  } else {
    return undefined;
  }

  return {
    id: `${scope}:${activePath}`,
    scope,
    state,
    activePath,
    disabledPath,
    displayName: `${label}/${normalizeRelativePath(relative(root, activePath))}`,
    summary: await readSummary(summaryPath),
  };
}

/**
 * Parse a directory containing a manifest-declared entrypoint or index.ts/js file as one or more
 * extension entries.
 */
async function parseDirectoryExtensions(
  root: string,
  label: string,
  scope: Scope,
  dirName: string
): Promise<ExtensionEntry[]> {
  const dir = join(root, dirName);
  const manifestEntrypoints = await resolveManifestLocalEntrypoints(dir);

  if (manifestEntrypoints !== undefined) {
    const entries = await Promise.all(
      manifestEntrypoints.map((extensionPath) =>
        toDirectoryExtensionEntry(root, label, scope, dir, extensionPath)
      )
    );
    return entries.filter((entry): entry is ExtensionEntry => Boolean(entry));
  }

  const fallbackEntries = await Promise.all(
    ["index.ts", "index.js"].map((extensionPath) =>
      toDirectoryExtensionEntry(root, label, scope, dir, extensionPath)
    )
  );

  return fallbackEntries.filter((entry): entry is ExtensionEntry => Boolean(entry)).slice(0, 1);
}

/**
 * Remove duplicate extensions, keeping the first occurrence of each ID.
 *
 * @param entries - Array of extension entries
 * @returns Deduplicated array
 */
function dedupeExtensions(entries: ExtensionEntry[]): ExtensionEntry[] {
  const byId = new Map<string, ExtensionEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values());
}

/**
 * Set the state (enabled/disabled) of a local extension.
 * This works by renaming the file with a .disabled suffix.
 *
 * @param entry - Extension with activePath and disabledPath defined
 * @param target - Target state ("enabled" or "disabled")
 * @returns Result object indicating success or failure with error message
 *
 * @example
 * ```typescript
 * const result = await setExtensionState(extension, "disabled");
 * if (!result.ok) {
 *   console.error("Failed:", result.error);
 * }
 * ```
 */
export async function setExtensionState(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
  target: State
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!entry.activePath || !entry.disabledPath) {
      return { ok: false, error: "Missing paths" };
    }
    if (target === "enabled") {
      await rename(entry.disabledPath, entry.activePath);
    } else {
      await rename(entry.activePath, entry.disabledPath);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove a local extension from disk.
 *
 * If the extension is in a subdirectory with an index file, the entire
 * directory is removed. Otherwise, just the file is removed.
 *
 * @param entry - Extension with activePath and disabledPath defined
 * @param cwd - Current working directory for determining project root
 * @returns Result with removed path and whether a directory was removed
 *
 * @example
 * ```typescript
 * const result = await removeLocalExtension(extension, process.cwd());
 * if (result.ok) {
 *   console.log(`Removed: ${result.removedPath}`);
 * }
 * ```
 */
export async function removeLocalExtension(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
  cwd: string
): Promise<
  { ok: true; removedPath: string; removedDirectory: boolean } | { ok: false; error: string }
> {
  try {
    const globalRoot = join(homedir(), ".pi", "agent", "extensions");
    const projectRoot = join(cwd, ".pi", "extensions");

    const activeExists = await fileExists(entry.activePath);
    const disabledExists = await fileExists(entry.disabledPath);

    if (!activeExists && !disabledExists) {
      return { ok: false, error: "Extension file no longer exists" };
    }

    const existingPath = activeExists ? entry.activePath : entry.disabledPath;
    const parentDir = dirname(existingPath);
    const normalizedBase = basename(existingPath).replace(/\.disabled$/i, "");
    const isIndexFile = /^index\.(ts|js)$/i.test(normalizedBase);
    const isInsideExtensionDir = parentDir !== globalRoot && parentDir !== projectRoot;

    if (isIndexFile && isInsideExtensionDir) {
      await rm(parentDir, { recursive: true, force: true });
      return { ok: true, removedPath: parentDir, removedDirectory: true };
    }

    await rm(existingPath, { force: true });
    return { ok: true, removedPath: existingPath, removedDirectory: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
