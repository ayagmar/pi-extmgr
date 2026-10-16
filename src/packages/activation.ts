/** Reversible, scope-local suspension of all resources from a configured package. */
import { type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type PackageUnifiedItem, type Scope, type State } from "../types/index.js";
import { getAgentDir } from "../utils/pi-paths.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";
import { applyPackageExtensionStateChanges } from "./extensions.js";
import {
  DISABLED_SNAPSHOT_KEY,
  findConfiguredPackageIndex,
  getScopedPackages,
  isDisabledPackageEntry,
} from "./package-settings.js";

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const CONTROLLED_FIELDS = [...RESOURCE_FIELDS, "autoload"] as const;
type ControlledFields = Partial<Record<(typeof RESOURCE_FIELDS)[number], string[]>> & {
  autoload?: boolean;
};
type PackageEntry = Record<string, unknown> & { source: string };
interface DisabledSnapshot {
  version: 1;
  originalForm: "string" | "object";
  fields: ControlledFields;
}
export type PackageStateChangeResult =
  | { ok: true; changed: boolean; message?: string }
  | { ok: false; error: string; snapshotConflict?: boolean };

/** The disabled filters were edited after the snapshot was saved. */
class SnapshotConflictError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadsNothing(entry: Record<string, unknown>): boolean {
  return RESOURCE_FIELDS.every((key) => {
    const filter = entry[key];
    return Array.isArray(filter) && filter.length === 0;
  });
}

function validateFields(fields: Record<string, unknown>): void {
  for (const field of RESOURCE_FIELDS) {
    const filter = fields[field];
    if (
      Object.hasOwn(fields, field) &&
      (!Array.isArray(filter) || !filter.every((token: unknown) => typeof token === "string"))
    ) {
      throw new Error(`Invalid ${field} filter; expected an array of strings.`);
    }
  }
  if (Object.hasOwn(fields, "autoload") && typeof fields.autoload !== "boolean") {
    throw new Error("Invalid autoload setting; expected a boolean.");
  }
}

function readSnapshot(entry: PackageEntry): DisabledSnapshot | undefined {
  if (!Object.hasOwn(entry, DISABLED_SNAPSHOT_KEY)) {
    return undefined;
  }
  const saved = entry[DISABLED_SNAPSHOT_KEY];
  if (
    !isRecord(saved) ||
    saved.version !== 1 ||
    (saved.originalForm !== "string" && saved.originalForm !== "object") ||
    !isRecord(saved.fields) ||
    Object.keys(saved).some((key) => !["version", "originalForm", "fields"].includes(key)) ||
    Object.keys(saved.fields).some(
      (key) => !(CONTROLLED_FIELDS as readonly string[]).includes(key)
    ) ||
    (saved.originalForm === "string" && Object.keys(saved.fields).length !== 0)
  ) {
    throw new Error(
      `Invalid or unsupported ${DISABLED_SNAPSHOT_KEY} snapshot. Reconcile the package settings manually.`
    );
  }
  validateFields(saved.fields);
  if (entry.autoload !== true || !loadsNothing(entry)) {
    throw new SnapshotConflictError(
      "Package filters were edited after extmgr disabled the package."
    );
  }
  return saved as unknown as DisabledSnapshot;
}

function toPackageEntry(original: PackageSource): PackageEntry {
  return typeof original === "string" ? { source: original } : structuredClone(original);
}

/** Collapse an entry that only names its source back to the string form. */
function toPackageSource(entry: PackageEntry): PackageSource {
  return Object.keys(entry).length === 1 ? entry.source : (entry as PackageSource);
}

/** Rewrite one configured package entry; `edit` returns undefined to leave settings untouched. */
async function editPackageEntry(
  source: string,
  scope: Scope,
  cwd: string,
  projectTrusted: boolean,
  edit: (original: PackageSource) => PackageSource | undefined
): Promise<boolean> {
  if (scope === "project" && !projectTrusted) {
    throw new Error("Project is not trusted; package settings were not changed.");
  }
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  throwIfSettingsErrors(settings, "Package activation");
  const packages = getScopedPackages(settings, scope);
  const index = findConfiguredPackageIndex(packages, source, scope, cwd);
  if (index < 0) {
    throw new Error("Package is not configured in this scope.");
  }
  const next = edit(packages[index] as PackageSource);
  if (next === undefined) {
    return false;
  }
  packages[index] = next;
  if (scope === "project") {
    settings.setProjectPackages(packages);
  } else {
    settings.setPackages(packages);
  }
  await settings.flush();
  throwIfSettingsErrors(settings, "Package activation");
  return true;
}

function toFailure(error: unknown): PackageStateChangeResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof SnapshotConflictError ? { snapshotConflict: true } : {}),
  };
}

export async function applyPackageStateChange(
  source: string,
  scope: Scope,
  target: State,
  cwd: string,
  projectTrusted = false
): Promise<PackageStateChangeResult> {
  let message: string | undefined;
  try {
    const changed = await editPackageEntry(source, scope, cwd, projectTrusted, (original) => {
      const entry = toPackageEntry(original);
      validateFields(entry);
      const saved = readSnapshot(entry);
      if (target === "disabled") {
        if (saved) {
          return undefined;
        }
        const fields: Record<string, unknown> = {};
        for (const key of CONTROLLED_FIELDS) {
          if (Object.hasOwn(entry, key)) {
            fields[key] = structuredClone(entry[key]);
          }
        }
        entry[DISABLED_SNAPSHOT_KEY] = {
          version: 1,
          originalForm: typeof original === "string" ? "string" : "object",
          fields,
        };
        for (const key of RESOURCE_FIELDS) {
          entry[key] = [];
        }
        entry.autoload = true;
        return entry as PackageSource;
      }

      if (!saved) {
        if (entry.autoload !== false && loadsNothing(entry)) {
          message =
            "No saved configuration exists. Edit resource filters explicitly to enable this package.";
        }
        return undefined;
      }
      for (const key of CONTROLLED_FIELDS) {
        delete entry[key];
        if (Object.hasOwn(saved.fields, key)) {
          entry[key] = structuredClone(saved.fields[key]);
        }
      }
      delete entry[DISABLED_SNAPSHOT_KEY];
      return saved.originalForm === "string" ? toPackageSource(entry) : (entry as PackageSource);
    });
    return { ok: true, changed, ...(message ? { message } : {}) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Forget the configuration saved by a disable and keep the package's current filters. */
export async function discardPackageSnapshot(
  source: string,
  scope: Scope,
  cwd: string,
  projectTrusted = false
): Promise<PackageStateChangeResult> {
  try {
    const changed = await editPackageEntry(source, scope, cwd, projectTrusted, (original) => {
      if (!isDisabledPackageEntry(original)) {
        return undefined;
      }
      const entry = toPackageEntry(original);
      delete entry[DISABLED_SNAPSHOT_KEY];
      return toPackageSource(entry);
    });
    return { ok: true, changed };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Whole-package toggle for an Installed item. Earlier extmgr versions disabled
 * only extension entrypoints and saved no snapshot, so enabling such a package
 * re-enables its entrypoints the way the old action did.
 */
export async function togglePackage(
  item: Pick<PackageUnifiedItem, "source" | "scope" | "extensionPaths" | "extensionSummary">,
  target: State,
  cwd: string,
  projectTrusted = false
): Promise<PackageStateChangeResult> {
  const result = await applyPackageStateChange(
    item.source,
    item.scope,
    target,
    cwd,
    projectTrusted
  );
  const summary = item.extensionSummary;
  // A message marks filters that deliberately load nothing; leave those alone.
  if (
    target === "disabled" ||
    !result.ok ||
    result.changed ||
    result.message ||
    !summary?.total ||
    summary.enabled > 0 ||
    !item.extensionPaths?.length
  ) {
    return result;
  }
  const legacy = await applyPackageExtensionStateChanges(
    item.source,
    item.scope,
    item.extensionPaths.map((extensionPath) => ({ extensionPath, target })),
    cwd,
    projectTrusted
  );
  return legacy.ok
    ? {
        ok: true,
        changed: true,
        message: "Re-enabled extensions disabled by an earlier extmgr version.",
      }
    : legacy;
}
