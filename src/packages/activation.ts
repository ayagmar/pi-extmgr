/** Reversible, scope-local suspension of all resources from a configured package. */
import { type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Scope, type State } from "../types/index.js";
import { normalizePackageIdentity, packageSourceString } from "../utils/package-source.js";
import { getAgentDir, getProjectConfigDir } from "../utils/pi-paths.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const CONTROLLED_FIELDS = [...RESOURCE_FIELDS, "autoload"] as const;
const SNAPSHOT_KEY = "piExtmgrDisabled";
type ControlledFields = Partial<Record<(typeof RESOURCE_FIELDS)[number], string[]>> & {
  autoload?: boolean;
};
interface DisabledSnapshot {
  version: 1;
  originalForm: "string" | "object";
  fields: ControlledFields;
}
export type PackageStateChangeResult =
  | { ok: true; changed: boolean; message?: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFields(fields: Record<string, unknown>): void {
  for (const field of RESOURCE_FIELDS) {
    if (
      Object.hasOwn(fields, field) &&
      (!Array.isArray(fields[field]) ||
        !fields[field].every((token: unknown) => typeof token === "string"))
    ) {
      throw new Error(`Invalid ${field} filter; expected an array of strings.`);
    }
  }
  if (Object.hasOwn(fields, "autoload") && typeof fields.autoload !== "boolean") {
    throw new Error("Invalid autoload setting; expected a boolean.");
  }
}

function readSnapshot(entry: Record<string, unknown>): DisabledSnapshot | undefined {
  if (!Object.hasOwn(entry, SNAPSHOT_KEY)) return undefined;
  const saved = entry[SNAPSHOT_KEY];
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
      "Invalid or unsupported piExtmgrDisabled snapshot. Reconcile the package settings manually."
    );
  }
  validateFields(saved.fields);
  if (
    entry.autoload !== true ||
    !RESOURCE_FIELDS.every((key) => Array.isArray(entry[key]) && entry[key].length === 0)
  ) {
    throw new Error(
      "Disabled package settings were edited externally. Reconcile the package settings manually before toggling."
    );
  }
  return saved as unknown as DisabledSnapshot;
}

function scopedPackages(settings: SettingsManager, scope: Scope): PackageSource[] {
  return [
    ...((scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings())
      .packages ?? []),
  ];
}

/** Exact spelling wins; otherwise match identity relative to the selected settings scope. */
export function findConfiguredPackageIndex(
  packages: PackageSource[],
  source: string,
  scope: Scope,
  cwd: string
): number {
  const exact = packages.flatMap((entry, index) =>
    packageSourceString(entry) === source ? [index] : []
  );
  const base = scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  const identity = normalizePackageIdentity(source, { cwd: base });
  const matches = exact.length
    ? exact
    : packages.flatMap((entry, index) =>
        normalizePackageIdentity(packageSourceString(entry), { cwd: base }) === identity
          ? [index]
          : []
      );
  if (matches.length > 1) throw new Error("Ambiguous package configuration in this scope.");
  return matches[0] ?? -1;
}

export async function applyPackageStateChange(
  source: string,
  scope: Scope,
  target: State,
  cwd: string,
  projectTrusted = false
): Promise<PackageStateChangeResult> {
  try {
    if (scope === "project" && !projectTrusted)
      throw new Error("Project is not trusted; package settings were not changed.");
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
    throwIfSettingsErrors(settings, "Package activation");
    const packages = scopedPackages(settings, scope);
    const index = findConfiguredPackageIndex(packages, source, scope, cwd);
    if (index < 0) throw new Error("Package is not configured in this scope.");
    const original = packages[index] as PackageSource;
    const entry: Record<string, unknown> & { source: string } =
      typeof original === "string" ? { source: original } : structuredClone(original);
    validateFields(entry);
    const saved = readSnapshot(entry);
    if (target === "disabled") {
      if (saved) return { ok: true, changed: false };
      const fields: Record<string, unknown> = {};
      for (const key of CONTROLLED_FIELDS)
        if (Object.hasOwn(entry, key)) fields[key] = structuredClone(entry[key]);
      entry[SNAPSHOT_KEY] = {
        version: 1,
        originalForm: typeof original === "string" ? "string" : "object",
        fields,
      };
      for (const key of RESOURCE_FIELDS) entry[key] = [];
      entry.autoload = true;
      packages[index] = entry;
    } else {
      if (!saved)
        return {
          ok: true,
          changed: false,
          ...(entry.autoload !== false &&
          RESOURCE_FIELDS.every((key) => Array.isArray(entry[key]) && entry[key].length === 0)
            ? {
                message:
                  "No saved configuration exists. Edit resource filters explicitly to enable this package.",
              }
            : {}),
        };
      for (const key of CONTROLLED_FIELDS) {
        delete entry[key];
        if (Object.hasOwn(saved.fields, key)) entry[key] = structuredClone(saved.fields[key]);
      }
      delete entry[SNAPSHOT_KEY];
      packages[index] =
        saved.originalForm === "string" && Object.keys(entry).length === 1 ? entry.source : entry;
    }
    if (scope === "project") settings.setProjectPackages(packages);
    else settings.setPackages(packages);
    await settings.flush();
    throwIfSettingsErrors(settings, "Package activation");
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
