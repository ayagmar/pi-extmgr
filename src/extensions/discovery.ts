/**
 * Local extension discovery
 *
 * This module handles discovery and management of local Pi extensions
 * in both global (<agentDir>/extensions) and project (.pi/extensions) scopes.
 */

import { type Dirent } from "node:fs";
import { readdir, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DISABLED_SUFFIX } from "../constants.js";
import { readPackageManifest } from "../packages/extensions.js";
import { type ExtensionEntry, type Scope, type State } from "../types/index.js";
import { fileExists, readSummary } from "../utils/fs.js";
import { logWarning } from "../utils/log.js";
import {
  CONFIG_DIR_NAME,
  getExtmgrTrashDir,
  getGlobalExtensionsDir,
  getProjectExtensionsDir,
} from "../utils/pi-paths.js";
import {
  normalizeRelativePath,
  resolveRelativePathSelection,
} from "../utils/relative-path-selection.js";
import {
  planExtensionOverrideCleanup,
  resolveTopLevelExtensionStates,
} from "./settings-overrides.js";
import { moveToExtensionTrash, type TrashRecord } from "./trash.js";

interface RootConfig {
  root: string;
  scope: Scope;
  label: string;
}

/**
 * Discover all local extensions in both global and project scopes.
 *
 * Project extensions are only listed for trusted projects: pi does not load
 * an untrusted project's `.pi/extensions`, so extmgr must not show, toggle
 * or delete them either.
 *
 * An entry is disabled when its file carries the `.disabled` suffix or when
 * pi does not load it because of an override in the `extensions` setting.
 *
 * @param cwd - Current working directory for resolving project scope
 * @param options.projectTrusted - Result of `ctx.isProjectTrusted()`
 * @returns Array of extension entries, sorted alphabetically by display name
 *
 * @example
 * ```typescript
 * const extensions = await discoverExtensions(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
 * for (const ext of extensions) {
 *   console.log(`${ext.displayName}: ${ext.state}`);
 * }
 * ```
 */
export async function discoverExtensions(
  cwd: string,
  options: { projectTrusted: boolean }
): Promise<ExtensionEntry[]> {
  const roots: RootConfig[] = [
    {
      root: getGlobalExtensionsDir(),
      scope: "global",
      label: "global extensions",
    },
  ];
  if (options.projectTrusted) {
    roots.push({
      root: getProjectExtensionsDir(cwd),
      scope: "project",
      label: `${CONFIG_DIR_NAME}/extensions`,
    });
  }

  const all: ExtensionEntry[] = [];
  for (const root of roots) {
    all.push(...(await discoverInRoot(root.root, root.scope, root.label)));
  }

  const piStates = await resolveTopLevelExtensionStates(cwd, options.projectTrusted);
  for (const entry of all) {
    if (entry.state === "enabled" && piStates.get(resolve(entry.activePath)) === false) {
      entry.state = "disabled";
      entry.settingsDisabled = true;
    }
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
    logWarning(`Error reading ${root}:`, error);
    return [];
  }

  const found: ExtensionEntry[] = [];

  for (const item of dirEntries) {
    const name = item.name;

    // Skip hidden entries (.temp, .git, …) and node_modules, as pi does.
    if (name.startsWith(".") || name === "node_modules") continue;

    const kind = await resolveEntryKind(root, item);

    if (kind === "file") {
      const entry = await parseTopLevelFile(root, label, scope, name);
      if (entry) found.push(entry);
      continue;
    }

    if (kind === "directory") {
      const linkTarget = item.isSymbolicLink()
        ? await realpath(join(root, name)).catch(() => undefined)
        : undefined;
      found.push(...(await parseDirectoryExtensions(root, label, scope, name, linkTarget)));
    }
  }

  return found;
}

/**
 * pi follows symlinks in extension directories (a common way to load an
 * extension under development), so resolve them to what they point at.
 * Broken links are skipped.
 */
async function resolveEntryKind(
  root: string,
  item: Dirent
): Promise<"file" | "directory" | undefined> {
  if (item.isFile()) return "file";
  if (item.isDirectory()) return "directory";
  if (!item.isSymbolicLink()) return undefined;
  try {
    const target = await stat(join(root, item.name));
    return target.isFile() ? "file" : target.isDirectory() ? "directory" : undefined;
  } catch {
    return undefined;
  }
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
  extensionPath: string,
  linkTarget?: string
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
    ...(linkTarget ? { linkTarget } : {}),
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
  dirName: string,
  linkTarget?: string
): Promise<ExtensionEntry[]> {
  const dir = join(root, dirName);
  const manifestEntrypoints = await resolveManifestLocalEntrypoints(dir);

  if (manifestEntrypoints !== undefined) {
    const entries = await Promise.all(
      manifestEntrypoints.map((extensionPath) =>
        toDirectoryExtensionEntry(root, label, scope, dir, extensionPath, linkTarget)
      )
    );
    return entries.filter((entry): entry is ExtensionEntry => Boolean(entry));
  }

  const fallbackEntries = await Promise.all(
    ["index.ts", "index.js"].map((extensionPath) =>
      toDirectoryExtensionEntry(root, label, scope, dir, extensionPath, linkTarget)
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
 * With `settings`, enabling also removes the exact `-`/`!` entries naming
 * this file in the user and (trusted) project `extensions` setting, so a
 * stale override (for example one `pi config` wrote) cannot keep overruling
 * the rename. `+` entries are kept, and disabling never writes settings. An entry disabled only by such an override is enabled by removing
 * it, without a rename.
 *
 * @param entry - Extension with activePath and disabledPath defined
 * @param target - Target state ("enabled" or "disabled")
 * @param settings - Where pi's settings live; omit to only rename
 * @returns Result object indicating success or failure with error message
 *
 * @example
 * ```typescript
 * const result = await setExtensionState(extension, "disabled", { cwd, projectTrusted });
 * if (!result.ok) {
 *   console.error("Failed:", result.error);
 * }
 * ```
 */
export async function setExtensionState(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath" | "linkTarget" | "settingsDisabled">,
  target: State,
  settings?: { cwd: string; projectTrusted: boolean }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!entry.activePath || !entry.disabledPath) {
      return { ok: false, error: "Missing paths" };
    }

    const verb = target === "enabled" ? "enable" : "disable";
    const settingsBlockError = `Cannot enable ${entry.activePath}: a pattern in the "extensions" setting disables it. Edit the setting or use pi config.`;
    // Enabling an entry that only a settings override disabled needs no rename.
    const needsRename = !(target === "enabled" && entry.settingsDisabled);

    if (needsRename && entry.linkTarget) {
      // pi loads every entry of a linked directory whatever the link is
      // called, and renaming a file inside it would edit the link target.
      return {
        ok: false,
        error: `Cannot ${verb} ${entry.activePath}: it is in a symlinked extension directory (-> ${entry.linkTarget}). Remove the link to stop loading it.`,
      };
    }

    // Disabling never writes settings: the rename alone stops pi loading the
    // file, and a `+path` entry must survive so a later enable works.
    const cleanup =
      settings && target === "enabled"
        ? planExtensionOverrideCleanup(entry.activePath, settings.cwd, settings.projectTrusted)
        : undefined;
    if (target === "enabled" && entry.settingsDisabled) {
      if (cleanup?.readError) {
        return {
          ok: false,
          error: `Cannot enable ${entry.activePath}: Pi settings could not be read (${cleanup.readError})`,
        };
      }
      if (!cleanup || cleanup.removed === 0) {
        return { ok: false, error: settingsBlockError };
      }
    }

    let undoRename: (() => Promise<void>) | undefined;
    if (needsRename) {
      const source = target === "enabled" ? entry.disabledPath : entry.activePath;
      const destination = target === "enabled" ? entry.activePath : entry.disabledPath;
      if (source !== destination) {
        // Check before rename so an active/disabled pair is never silently
        // overwritten. This is intentionally a preflight: filesystem races can
        // still only be mitigated, not made transactional, by this API.
        if (await fileExists(destination)) {
          return {
            ok: false,
            error: `Cannot ${verb} extension: destination already exists (${destination})`,
          };
        }

        await rename(source, destination);
        undoRename = () => rename(destination, source);
      }
    }

    if (!cleanup) return { ok: true };
    // Undo the rename when enabling cannot take effect or the settings write
    // fails, so the file, the settings and the staged UI change stay
    // consistent and a retry works.
    const rollback = async (error: string) => {
      if (!undoRename) return { ok: false as const, error };
      try {
        await undoRename();
        return { ok: false as const, error };
      } catch (undoError) {
        const reason = undoError instanceof Error ? undoError.message : String(undoError);
        return {
          ok: false as const,
          error: `${error} (the rename could not be undone: ${reason})`,
        };
      }
    };
    // pi applies `!glob` entries too, which no exact-entry cleanup removes.
    if ((await cleanup.enabledAfterApply()) === false) {
      return rollback(settingsBlockError);
    }
    try {
      await cleanup.apply();
    } catch (error) {
      return rollback(error instanceof Error ? error.message : String(error));
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
 * const result = await removeLocalExtension(extension, ctx.cwd);
 * if (result.ok) {
 *   console.log(`Removed: ${result.removedPath}`);
 * }
 * ```
 */
export async function removeLocalExtension(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
  cwd: string
): Promise<
  | { ok: true; removedPath: string; removedDirectory: boolean; trashRecord: TrashRecord }
  | { ok: false; error: string }
> {
  try {
    const globalRoot = getGlobalExtensionsDir();
    const projectRoot = getProjectExtensionsDir(cwd);

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

    const trashRoot = getExtmgrTrashDir();
    if (isIndexFile && isInsideExtensionDir) {
      const trashRecord = await moveToExtensionTrash(parentDir, trashRoot);
      return { ok: true, removedPath: parentDir, removedDirectory: true, trashRecord };
    }

    const trashRecord = await moveToExtensionTrash(existingPath, trashRoot);
    return { ok: true, removedPath: existingPath, removedDirectory: false, trashRecord };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
