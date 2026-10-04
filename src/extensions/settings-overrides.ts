/**
 * pi applies the `extensions` setting to auto-discovered local extensions:
 * `-path` and `!pattern` stop one from loading, `+path` forces it back on.
 * `pi config` writes exactly these entries. This module reads the effective
 * state from pi and, when enabling, clears the exact `-`/`!` entries that
 * block one extension, so the `.disabled` rename extmgr uses is not silently
 * overruled by a stale override. `+` entries are never removed: they are
 * what lets a file through a `!glob`.
 */
import { join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "../utils/pi-paths.js";

/**
 * Whether pi loads each top-level extension file it found (auto-discovered or
 * listed in settings), keyed by resolved path. Empty when pi cannot resolve.
 */
export async function resolveTopLevelExtensionStates(
  cwd: string,
  projectTrusted: boolean
): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const { extensions } = await packageManager.resolve(async () => "skip");
    for (const resource of extensions) {
      if (resource.metadata.origin !== "top-level") continue;
      const key = resolve(resource.path);
      if (!states.has(key)) states.set(key, resource.enabled);
    }
  } catch {
    // Fall back to the filename state alone.
  }
  return states;
}

/** Entries that stop a file from loading; `+` entries are never removed. */
const BLOCKING_PREFIX = /^[-!]/;

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

/** pi's exact-pattern normalization: drop a leading `./`, use `/`. */
function normalizeExactPattern(pattern: string): string {
  const trimmed =
    pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return toPosixPath(trimmed);
}

/** Drop `-`/`!` entries that name exactly this file (relative or absolute). */
function withoutOverridesFor(
  entries: readonly string[] | undefined,
  filePath: string,
  baseDir: string
): string[] | undefined {
  if (!entries || entries.length === 0) return undefined;
  const targets = new Set([toPosixPath(relative(baseDir, filePath)), toPosixPath(filePath)]);
  const kept = entries.filter(
    (entry) => !(BLOCKING_PREFIX.test(entry) && targets.has(normalizeExactPattern(entry.slice(1))))
  );
  return kept.length === entries.length ? undefined : kept;
}

export interface ExtensionOverrideCleanup {
  /** Settings could not be read; nothing will be written. */
  readError?: string;
  /** Number of override entries that apply() removes. */
  removed: number;
  apply(): Promise<void>;
}

/**
 * Plan removing the exact `-`/`!` entries for one extension file from the user
 * and (when trusted) project `extensions` settings. Other entries, such as
 * `-builtin:*` or glob patterns, are kept. Writes go through pi's settings
 * setters, so unrelated settings are preserved.
 */
export function planExtensionOverrideCleanup(
  filePath: string,
  cwd: string,
  projectTrusted: boolean
): ExtensionOverrideCleanup {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const readErrors = settings.drainErrors();
  if (readErrors.length > 0) {
    return {
      readError: readErrors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "),
      removed: 0,
      apply: () => Promise.resolve(),
    };
  }

  const absolutePath = resolve(filePath);
  const globalEntries = withoutOverridesFor(
    settings.getGlobalSettings().extensions,
    absolutePath,
    agentDir
  );
  const projectEntries = projectTrusted
    ? withoutOverridesFor(
        settings.getProjectSettings().extensions,
        absolutePath,
        join(cwd, CONFIG_DIR_NAME)
      )
    : undefined;
  const removed =
    (globalEntries
      ? (settings.getGlobalSettings().extensions?.length ?? 0) - globalEntries.length
      : 0) +
    (projectEntries
      ? (settings.getProjectSettings().extensions?.length ?? 0) - projectEntries.length
      : 0);

  return {
    removed,
    async apply() {
      if (removed === 0) return;
      if (globalEntries) settings.setExtensionPaths(globalEntries);
      if (projectEntries) settings.setProjectExtensionPaths(projectEntries);
      await settings.flush();
      const writeErrors = settings.drainErrors();
      if (writeErrors.length > 0) {
        throw new Error(
          `Could not update Pi settings: ${writeErrors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ")}`
        );
      }
    },
  };
}
