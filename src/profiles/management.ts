import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ProfilePlan, planProfileApplication } from "./apply.js";
import { type ProfilePackageDiagnostic, type ProfilePolicyViolation } from "./compare.js";
import { type ExtmgrProfile, parseExternalProfile } from "./schema.js";
import { type LoadedProfileSource, loadProfileSource } from "./source.js";
import {
  deleteNamedProfile,
  duplicateNamedProfile,
  getNamedProfile,
  getProfileStorePath,
  readProfileStore,
  renameNamedProfile,
  saveNamedProfile,
} from "./store.js";

export interface ProfileStoreOptions {
  storePath?: string;
}

export interface ProfileReplaceOptions extends ProfileStoreOptions {
  replace: boolean;
}

export interface PreparedProfileImport {
  profile: ExtmgrProfile;
  loaded: LoadedProfileSource;
  migration: { fromVersion: number; migrated: boolean };
  warnings: string[];
}

export interface ProfileImportReview {
  plan: ProfilePlan;
  summaryLines: string[];
  level: "info" | "warning";
}

export interface ProfileImportReviewOptions {
  projectCwd: string;
  globalCwd: string;
  diagnostics: ProfilePackageDiagnostic[];
  policyViolations: ProfilePolicyViolation[];
}

function storePath(options?: ProfileStoreOptions): string {
  return options?.storePath ?? getProfileStorePath();
}

function requireName(name: string, label = "Profile name"): string {
  const normalized = name.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function parseSuppliedProfile(profile: ExtmgrProfile, name = profile.name): ExtmgrProfile {
  const parsed = parseExternalProfile({ ...profile, name: requireName(name) });
  if (parsed.ok) return parsed.profile;
  throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
}

export async function listProfiles(options?: ProfileStoreOptions): Promise<ExtmgrProfile[]> {
  const store = await readProfileStore(storePath(options));
  return Object.values(store.profiles).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProfile(
  name: string,
  options?: ProfileStoreOptions
): Promise<ExtmgrProfile | undefined> {
  const store = await readProfileStore(storePath(options));
  return getNamedProfile(store, requireName(name));
}

export async function saveProfile(
  profile: ExtmgrProfile,
  name: string,
  options: ProfileReplaceOptions
): Promise<ExtmgrProfile> {
  const saved = parseSuppliedProfile(profile, name);
  const written = await saveNamedProfile(storePath(options), saved, { replace: options.replace });
  return written.profiles[saved.name] as ExtmgrProfile;
}

export async function exportProfile(
  profile: ExtmgrProfile,
  destination: string,
  options: { cwd: string }
): Promise<string> {
  const requested = destination.trim();
  if (!requested) throw new Error("Export destination must not be empty.");
  const exported = parseSuppliedProfile(profile);
  const path = resolve(options.cwd, requested);
  await writeFile(path, `${JSON.stringify(exported, null, 2)}\n`, { flag: "wx" });
  return path;
}

export async function deleteProfile(name: string, options?: ProfileStoreOptions): Promise<boolean> {
  return deleteNamedProfile(storePath(options), requireName(name));
}

export async function renameProfile(
  sourceName: string,
  destinationName: string,
  options: ProfileReplaceOptions
): Promise<ExtmgrProfile> {
  const written = await renameNamedProfile(
    storePath(options),
    requireName(sourceName, "Source profile name"),
    requireName(destinationName, "Destination profile name"),
    { replace: options.replace }
  );
  return written.profiles[destinationName.trim()] as ExtmgrProfile;
}

export async function duplicateProfile(
  sourceName: string,
  destinationName: string,
  options: ProfileReplaceOptions
): Promise<ExtmgrProfile> {
  const written = await duplicateNamedProfile(
    storePath(options),
    requireName(sourceName, "Source profile name"),
    requireName(destinationName, "Destination profile name"),
    { replace: options.replace }
  );
  return written.profiles[destinationName.trim()] as ExtmgrProfile;
}

export function buildProfileImportReview(
  prepared: PreparedProfileImport,
  current: ExtmgrProfile,
  options: ProfileImportReviewOptions
): ProfileImportReview {
  const { loaded, profile } = prepared;
  const plan = planProfileApplication(current, profile, {
    projectCwd: options.projectCwd,
    globalCwd: options.globalCwd,
  });
  const globalPackages = profile.packages.filter((pkg) => pkg.scope === "global").length;
  const projectPackages = profile.packages.filter((pkg) => pkg.scope === "project").length;
  return {
    plan,
    level: loaded.warnings.length > 0 ? "warning" : "info",
    summaryLines: [
      `Origin: ${loaded.origin}`,
      `Final origin: ${loaded.finalOrigin}`,
      `Origin status: ${loaded.immutableOrigin === true ? "immutable" : loaded.immutableOrigin === false ? "floating" : "local"}`,
      `Content fingerprint: ${loaded.contentFingerprint}`,
      `Schema: v${prepared.migration.fromVersion}${prepared.migration.migrated ? " (migrated)" : ""}`,
      `Packages: ${profile.packages.length} (${globalPackages} global, ${projectPackages} project)`,
      `Preview: ${plan.add.length} add, ${plan.remove.length} remove, ${plan.update.length} change`,
      `Policy: ${options.policyViolations.length === 0 ? "pass" : `${options.policyViolations.length} violation(s)`}`,
      `Compatibility: ${options.diagnostics.filter((item) => item.compatibility === "unknown").length} unknown`,
      `Integrity: ${options.diagnostics.filter((item) => item.integrity === "unknown").length} unknown`,
      ...options.policyViolations.map((violation) => `Policy violation: ${violation.message}`),
      ...[...prepared.warnings, ...loaded.warnings].map((warning) => `Warning: ${warning}`),
    ],
  };
}

export async function prepareProfileImport(
  source: string,
  options: { cwd: string; signal?: AbortSignal; name?: string }
): Promise<PreparedProfileImport> {
  const loaded = await loadProfileSource(source, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const parsed = parseExternalProfile(loaded.value, { requireName: !options.name });
  if (!parsed.ok) {
    throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }
  const profile = parseSuppliedProfile(
    {
      ...parsed.profile,
      importMetadata: {
        origin: loaded.origin,
        finalOrigin: loaded.finalOrigin,
        ...(loaded.fetchedAt ? { fetchedAt: loaded.fetchedAt } : {}),
        contentFingerprint: loaded.contentFingerprint,
        warnings: [...loaded.warnings],
      },
    },
    options.name ?? parsed.profile.name
  );
  return {
    profile,
    loaded,
    migration: parsed.migration,
    warnings: parsed.warnings,
  };
}
