import { normalizePackageSource, parseNpmSource } from "../utils/format.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  splitGitRepoAndRef,
  stripGitSourcePrefix,
} from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";

export const PROFILE_SCHEMA_VERSION = 1 as const;

export type ProfileScope = "global" | "project";
export type ProfileResolution = "locked" | "floating";
export type DiagnosticStatus = "verified" | "failed" | "unknown";

export interface ProfilePackage {
  /** Configured source retained for round-tripping. */
  source: string;
  scope: ProfileScope;
  /** Exact npm version when locked, or configured npm tag/range when floating. */
  version?: string;
  /** Git ref. Commit hashes are treated as immutable locked refs. */
  ref?: string;
  resolution?: ProfileResolution;
  filters?: string[];
  /** Honest package.json-only diagnostic; never artifact integrity evidence. */
  manifestFingerprint?: string;
  /** Legacy alias retained for v1 readers. It is never trusted as integrity evidence. */
  checksum?: string;
  /** Locally established artifact integrity, when a public package API provides it. */
  integrity?: string;
  /** Additional Pi package settings retained across profile export/apply. */
  packageSettings?: Record<string, unknown>;
  legacyMetadata?: Record<string, unknown>;
}

export interface ProfileImportMetadata {
  origin: string;
  finalOrigin?: string;
  fetchedAt?: string;
  contentFingerprint?: string;
  warnings?: string[];
}

export interface ExtmgrProfile {
  schemaVersion: 1;
  name: string;
  packages: ProfilePackage[];
  /** Imported claims are preserved for migration/display only and are never trusted. */
  checks?: { compatibility?: boolean; provenance?: boolean };
  importMetadata?: ProfileImportMetadata;
}

export interface ProfileValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ProfileMigration {
  fromVersion: number;
  toVersion: 1;
  migrated: boolean;
  notes: string[];
}

export type ExternalProfileParseResult =
  | { ok: true; profile: ExtmgrProfile; migration: ProfileMigration; warnings: string[] }
  | { ok: false; errors: ProfileValidationIssue[] };

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const EXACT_VERSION_PATTERN =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const IMMUTABLE_GIT_REF_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 0x20 || /\s/u.test(character));
}

function isValidGitRefSyntax(ref: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "\\"]);
  if (
    !ref ||
    ref.length > 256 ||
    hasWhitespaceOrControl(ref) ||
    [...ref].some((character) => forbidden.has(character)) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    return false;
  }
  return ref.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalProfileSource(source: string): string {
  const trimmed = source.trim();
  return getPackageSourceKind(trimmed) === "unknown" ? normalizePackageSource(trimmed) : trimmed;
}

function sourceTarget(source: string): { version?: string; ref?: string; repo?: string } {
  const canonical = canonicalProfileSource(source);
  const npm = parseNpmSource(canonical);
  if (npm?.version) return { version: npm.version };
  if (getPackageSourceKind(canonical) === "git") {
    const parsed = splitGitRepoAndRef(stripGitSourcePrefix(canonical));
    return { repo: parsed.repo, ...(parsed.ref ? { ref: parsed.ref } : {}) };
  }
  return {};
}

export function isExactNpmVersion(version: string | undefined): boolean {
  return Boolean(version && EXACT_VERSION_PATTERN.test(version));
}

export function isImmutableGitRef(ref: string | undefined): boolean {
  return Boolean(ref && IMMUTABLE_GIT_REF_PATTERN.test(ref));
}

export function isValidGitRef(ref: string | undefined): boolean {
  return Boolean(ref && isValidGitRefSyntax(ref));
}

export function inferPackageResolution(
  pkg: Pick<ProfilePackage, "source" | "version" | "ref">
): ProfileResolution {
  const source = canonicalProfileSource(pkg.source);
  const target = sourceTarget(source);
  const kind = getPackageSourceKind(source);
  const version = pkg.version ?? target.version;
  const ref = pkg.ref ?? target.ref;
  if (kind === "npm" && isExactNpmVersion(version)) return "locked";
  if (kind === "git" && isImmutableGitRef(ref)) return "locked";
  return "floating";
}

/** Central package mutation source used by planning, applying, persistence, and display. */
export function getEffectivePackageSource(pkg: ProfilePackage): string {
  const source = canonicalProfileSource(pkg.source);
  const kind = getPackageSourceKind(source);
  const resolution = pkg.resolution ?? inferPackageResolution(pkg);
  if (kind === "npm") {
    const parsed = parseNpmSource(source);
    if (!parsed) return source;
    const target = pkg.version ?? parsed.version;
    if (!target) return source;
    if (resolution === "locked" && !isExactNpmVersion(target)) return source;
    return `npm:${parsed.name}@${target}`;
  }
  if (kind === "git") {
    const spec = stripGitSourcePrefix(source);
    const parsed = splitGitRepoAndRef(spec);
    const ref = pkg.ref ?? parsed.ref;
    const prefix = source.startsWith("git:") ? "git:" : source.startsWith("git+") ? "git+" : "";
    const base = parsed.repo;
    return ref ? `${prefix}${base}@${ref}` : source;
  }
  return source;
}

export function getProfilePackageIdentity(
  pkg: ProfilePackage,
  options?: { projectCwd?: string; globalCwd?: string }
): string {
  const cwd =
    pkg.scope === "project"
      ? options?.projectCwd
        ? getProjectConfigDir(options.projectCwd)
        : undefined
      : options?.globalCwd;
  return normalizePackageIdentity(getEffectivePackageSource(pkg), cwd ? { cwd } : undefined);
}

const PROFILE_PACKAGE_FIELDS = new Set([
  "source",
  "scope",
  "version",
  "ref",
  "resolution",
  "filters",
  "manifestFingerprint",
  "checksum",
  "integrity",
  "packageSettings",
  "legacyMetadata",
  "extensions",
]);

function extractPackageSettings(
  item: Record<string, unknown>
): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const supplied = item.packageSettings;
  const hasSuppliedSettings = isRecord(supplied);
  if (hasSuppliedSettings) {
    for (const [key, value] of Object.entries(supplied)) settings[key] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(item)) {
    if (!PROFILE_PACKAGE_FIELDS.has(key)) settings[key] = structuredClone(value);
  }
  // `source` and `extensions` are represented by the canonical profile fields.
  delete settings.source;
  delete settings.extensions;
  return hasSuppliedSettings || Object.keys(settings).length > 0 ? settings : undefined;
}

function normalizePackage(item: Record<string, unknown>): ProfilePackage | undefined {
  const rawSource = nonEmptyString(item.source);
  if (!rawSource) return undefined;
  const source = canonicalProfileSource(rawSource);
  const scope: ProfileScope = item.scope === "project" ? "project" : "global";
  const version = nonEmptyString(item.version);
  const ref = nonEmptyString(item.ref);
  const nestedExtensions = isRecord(item.packageSettings)
    ? item.packageSettings.extensions
    : undefined;
  const rawFilters = item.filters ?? item.extensions ?? nestedExtensions;
  const filters = Array.isArray(rawFilters)
    ? rawFilters.filter((filter): filter is string => typeof filter === "string")
    : undefined;
  const checksum = nonEmptyString(item.checksum);
  const integrity = nonEmptyString(item.integrity);
  const manifestFingerprint = nonEmptyString(item.manifestFingerprint);
  const resolution =
    item.resolution === "locked" || item.resolution === "floating" ? item.resolution : undefined;
  const packageSettings = extractPackageSettings(item);
  return {
    source,
    scope,
    ...(resolution ? { resolution } : {}),
    ...(version ? { version } : {}),
    ...(ref ? { ref } : {}),
    ...(filters ? { filters } : {}),
    ...(manifestFingerprint ? { manifestFingerprint } : {}),
    ...(checksum ? { checksum } : {}),
    ...(integrity ? { integrity } : {}),
    ...(packageSettings ? { packageSettings } : {}),
    ...(isRecord(item.legacyMetadata)
      ? { legacyMetadata: structuredClone(item.legacyMetadata) }
      : {}),
  };
}

/**
 * Lenient normalization for already-owned in-memory data. External JSON must use
 * parseExternalProfile() so malformed entries cannot be silently discarded.
 */
export function normalizeProfile(input: unknown): ExtmgrProfile {
  const value = isRecord(input) ? input : {};
  const packages = Array.isArray(value.packages)
    ? value.packages.flatMap((item) => {
        if (!isRecord(item)) return [];
        const normalized = normalizePackage(item);
        return normalized ? [normalized] : [];
      })
    : [];
  const checks = isRecord(value.checks)
    ? {
        compatibility: value.checks.compatibility === true,
        provenance: value.checks.provenance === true,
      }
    : undefined;
  const importValue = isRecord(value.importMetadata) ? value.importMetadata : undefined;
  const finalOrigin = nonEmptyString(importValue?.finalOrigin);
  const fetchedAt = nonEmptyString(importValue?.fetchedAt);
  const contentFingerprint = nonEmptyString(importValue?.contentFingerprint);
  const importMetadata = importValue
    ? {
        origin: nonEmptyString(importValue.origin) ?? "unknown",
        ...(finalOrigin ? { finalOrigin } : {}),
        ...(fetchedAt ? { fetchedAt } : {}),
        ...(contentFingerprint ? { contentFingerprint } : {}),
        ...(Array.isArray(importValue.warnings)
          ? {
              warnings: importValue.warnings.filter(
                (warning): warning is string => typeof warning === "string"
              ),
            }
          : {}),
      }
    : undefined;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: nonEmptyString(value.name) ?? "unnamed",
    packages,
    ...(checks ? { checks } : {}),
    ...(importMetadata ? { importMetadata } : {}),
  };
}

function addIssue(
  issues: ProfileValidationIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message });
}

function validateStringArray(
  issues: ProfileValidationIssue[],
  value: unknown,
  path: string,
  label: string
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid-settings", `${label} must be an array of non-empty strings.`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.includes("\0")) {
      addIssue(
        issues,
        `${path}[${index}]`,
        "invalid-settings",
        `${label} entries must be non-empty strings without NUL characters.`
      );
    }
  });
}

/** Explicit, deterministic migration entry point for persisted/exported v1 profiles. */
export function migrateProfileV1(input: unknown): { profile: ExtmgrProfile; notes: string[] } {
  const parsed = parseExternalProfile(input);
  if (!parsed.ok)
    throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  return { profile: parsed.profile, notes: parsed.migration.notes };
}

/** Strict parser and explicit v1-to-canonical migration boundary for untrusted JSON. */
export function parseExternalProfile(
  input: unknown,
  options?: { requireName?: boolean }
): ExternalProfileParseResult {
  const issues: ProfileValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "type", message: "Profile must be a JSON object." }],
    };
  }
  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    addIssue(
      issues,
      "schemaVersion",
      "unsupported-version",
      "Unsupported or missing profile schemaVersion; expected 1."
    );
  }
  const name = nonEmptyString(input.name);
  if ((options?.requireName ?? true) && !name) {
    addIssue(issues, "name", "invalid-name", "Profile name must be a non-empty string.");
  }
  if (!Array.isArray(input.packages)) {
    addIssue(issues, "packages", "type", "Profile packages must be an array.");
  }
  if (input.checks !== undefined) {
    if (!isRecord(input.checks)) {
      addIssue(issues, "checks", "invalid-checks", "Profile checks must be an object.");
    } else {
      for (const field of ["compatibility", "provenance"] as const) {
        if (input.checks[field] !== undefined && typeof input.checks[field] !== "boolean") {
          addIssue(issues, `checks.${field}`, "invalid-check", `${field} check must be a boolean.`);
        }
      }
    }
  }

  if (input.importMetadata !== undefined) {
    if (!isRecord(input.importMetadata)) {
      addIssue(issues, "importMetadata", "invalid-metadata", "Import metadata must be an object.");
    } else {
      for (const field of ["origin", "finalOrigin", "fetchedAt", "contentFingerprint"] as const) {
        if (
          input.importMetadata[field] !== undefined &&
          (typeof input.importMetadata[field] !== "string" ||
            !String(input.importMetadata[field]).trim())
        ) {
          addIssue(
            issues,
            `importMetadata.${field}`,
            "invalid-metadata",
            `${field} must be a non-empty string.`
          );
        }
      }
      if (input.importMetadata.warnings !== undefined) {
        validateStringArray(
          issues,
          input.importMetadata.warnings,
          "importMetadata.warnings",
          "Warnings"
        );
      }
    }
  }

  const packages: ProfilePackage[] = [];
  const identities = new Set<string>();
  if (Array.isArray(input.packages)) {
    input.packages.forEach((raw, index) => {
      const path = `packages[${index}]`;
      if (!isRecord(raw)) {
        addIssue(issues, path, "malformed-package", "Package entry must be an object.");
        return;
      }
      const source = nonEmptyString(raw.source);
      if (!source)
        addIssue(
          issues,
          `${path}.source`,
          "invalid-source",
          "Package source must be a non-empty string."
        );
      if (raw.scope !== "global" && raw.scope !== "project") {
        addIssue(
          issues,
          `${path}.scope`,
          "invalid-scope",
          "Package scope must be global or project."
        );
      }
      const version = raw.version === undefined ? undefined : nonEmptyString(raw.version);
      const ref = raw.ref === undefined ? undefined : nonEmptyString(raw.ref);
      if (raw.version !== undefined && !version)
        addIssue(
          issues,
          `${path}.version`,
          "invalid-version",
          "Package version must be a non-empty string."
        );
      if (raw.ref !== undefined && !ref)
        addIssue(issues, `${path}.ref`, "invalid-ref", "Package ref must be a non-empty string.");
      if (version && ref)
        addIssue(
          issues,
          path,
          "conflicting-target",
          "A package cannot declare both version and ref."
        );
      if (
        raw.resolution !== undefined &&
        raw.resolution !== "locked" &&
        raw.resolution !== "floating"
      ) {
        addIssue(
          issues,
          `${path}.resolution`,
          "invalid-resolution",
          "Package resolution must be locked or floating."
        );
      }
      if (raw.packageSettings !== undefined && !isRecord(raw.packageSettings)) {
        addIssue(
          issues,
          `${path}.packageSettings`,
          "invalid-settings",
          "Package settings must be an object."
        );
      }
      if (raw.legacyMetadata !== undefined && !isRecord(raw.legacyMetadata)) {
        addIssue(
          issues,
          `${path}.legacyMetadata`,
          "invalid-metadata",
          "Legacy metadata must be an object."
        );
      }
      for (const field of ["skills", "prompts", "themes"] as const) {
        if (raw[field] !== undefined)
          validateStringArray(issues, raw[field], `${path}.${field}`, field);
        if (isRecord(raw.packageSettings) && raw.packageSettings[field] !== undefined) {
          validateStringArray(
            issues,
            raw.packageSettings[field],
            `${path}.packageSettings.${field}`,
            field
          );
        }
      }
      if (isRecord(raw.packageSettings) && raw.packageSettings.extensions !== undefined) {
        validateStringArray(
          issues,
          raw.packageSettings.extensions,
          `${path}.packageSettings.extensions`,
          "Extensions"
        );
      }
      if (source) {
        const canonicalSource = canonicalProfileSource(source);
        const kind = getPackageSourceKind(canonicalSource);
        const embedded = sourceTarget(canonicalSource);
        if (version && hasWhitespaceOrControl(version))
          addIssue(
            issues,
            `${path}.version`,
            "invalid-version",
            "Package version must not contain whitespace or control characters."
          );
        if (ref && !isValidGitRef(ref) && kind === "git")
          addIssue(issues, `${path}.ref`, "invalid-ref", "Git ref is not valid Git ref syntax.");
        if (embedded.ref && !isValidGitRef(embedded.ref))
          addIssue(
            issues,
            `${path}.source`,
            "invalid-source-ref",
            "Git source contains an invalid ref."
          );
        if (version && kind !== "npm")
          addIssue(
            issues,
            `${path}.version`,
            "conflicting-target",
            "Only npm packages may declare version."
          );
        if (ref && kind !== "git")
          addIssue(
            issues,
            `${path}.ref`,
            "conflicting-target",
            "Only git packages may declare ref."
          );
        if (version && embedded.version && version !== embedded.version)
          addIssue(
            issues,
            path,
            "conflicting-target",
            "Source version conflicts with declared version."
          );
        if (ref && embedded.ref && ref !== embedded.ref)
          addIssue(issues, path, "conflicting-target", "Source ref conflicts with declared ref.");
        if (kind === "git" && !embedded.repo?.trim())
          addIssue(
            issues,
            `${path}.source`,
            "invalid-source",
            "Git source must include a repository."
          );
        if (raw.resolution === "locked") {
          if (kind === "npm") {
            const targetVersion = version ?? embedded.version;
            if (!isExactNpmVersion(targetVersion))
              addIssue(
                issues,
                `${path}.resolution`,
                "invalid-locked-target",
                "Locked npm packages require an exact semantic version."
              );
          } else if (kind === "git") {
            const targetRef = ref ?? embedded.ref;
            if (!isImmutableGitRef(targetRef))
              addIssue(
                issues,
                `${path}.resolution`,
                "invalid-locked-target",
                "Locked git packages require a full 40- or 64-character hexadecimal commit ref."
              );
          } else {
            addIssue(
              issues,
              `${path}.resolution`,
              "invalid-locked-target",
              "Only npm and git packages can be locked."
            );
          }
        }
      }
      for (const field of ["integrity", "manifestFingerprint", "checksum"] as const) {
        if (
          raw[field] !== undefined &&
          (typeof raw[field] !== "string" || !SHA256_PATTERN.test(raw[field] as string))
        ) {
          addIssue(
            issues,
            `${path}.${field}`,
            "invalid-fingerprint",
            `${field} must use sha256:<64 hexadecimal characters>.`
          );
        }
      }
      if (raw.extensions !== undefined)
        validateStringArray(issues, raw.extensions, `${path}.extensions`, "Extensions");
      const nestedExtensions = isRecord(raw.packageSettings)
        ? raw.packageSettings.extensions
        : undefined;
      const filterRepresentations = [raw.filters, raw.extensions, nestedExtensions].filter(
        (value) => value !== undefined
      );
      if (
        filterRepresentations.length > 1 &&
        filterRepresentations.some(
          (value) => JSON.stringify(value) !== JSON.stringify(filterRepresentations[0])
        )
      ) {
        addIssue(
          issues,
          path,
          "conflicting-filters",
          "Package filters and extensions settings must agree when both are supplied."
        );
      }
      if (raw.filters !== undefined) {
        if (!Array.isArray(raw.filters)) {
          addIssue(
            issues,
            `${path}.filters`,
            "invalid-filters",
            "Package filters must be an array of non-empty strings."
          );
        } else {
          raw.filters.forEach((filter, filterIndex) => {
            if (typeof filter !== "string" || !filter.trim() || filter.includes("\0")) {
              addIssue(
                issues,
                `${path}.filters[${filterIndex}]`,
                "invalid-filter",
                "Filter must be a non-empty string without NUL characters."
              );
            }
          });
        }
      }
      if (source && (raw.scope === "global" || raw.scope === "project")) {
        const identity = `${raw.scope}\0${normalizePackageIdentity(canonicalProfileSource(source))}`;
        if (identities.has(identity))
          addIssue(
            issues,
            path,
            "duplicate-package",
            "Duplicate normalized package source and scope."
          );
        identities.add(identity);
      }
      const normalized = normalizePackage(raw);
      if (normalized) packages.push(normalized);
    });
  }

  if (issues.length > 0) return { ok: false, errors: issues };
  const profile = normalizeProfile({
    ...input,
    name: name ?? "unnamed",
    packages,
  });
  const notes: string[] = ["Schema v1 profile normalized through the explicit migration path."];
  if (profile.checks?.compatibility !== undefined || profile.checks?.provenance !== undefined) {
    notes.push(
      "Imported compatibility and provenance claims were retained as unverified legacy metadata."
    );
  }
  if (packages.some((pkg) => pkg.checksum)) {
    notes.push(
      "Legacy checksums were retained as unverified manifest-only metadata and are not artifact integrity evidence."
    );
  }
  return {
    ok: true,
    profile,
    migration: { fromVersion: 1, toVersion: 1, migrated: notes.length > 0, notes },
    warnings: [...notes],
  };
}

export function assertExternalProfile(
  input: unknown,
  options?: { requireName?: boolean }
): ExtmgrProfile {
  const parsed = parseExternalProfile(input, options);
  if (parsed.ok) return parsed.profile;
  throw new Error(parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
}
