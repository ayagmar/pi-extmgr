/**
 * Captures the installed runtime state as a profile and diagnoses profile
 * targets against it: exact-version/commit resolution, compatibility, and
 * install verification.
 */
import { dirname, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  VERSION,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inspectInstalledPackageCompatibility } from "../doctor/compatibility.js";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { type InstalledPackage } from "../types/index.js";
import { isProjectTrusted } from "../utils/mode.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  packageSourceString,
  parsePackageNameAndVersion,
  splitGitRepoAndRef,
  stripGitSourcePrefix,
} from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { readPackageManifestSnapshot } from "./checksum.js";
import { type ProfilePackageDiagnostic } from "./compare.js";
import {
  type ExtmgrProfile,
  getEffectivePackageSource,
  getProfilePackageIdentity,
  isExactNpmVersion,
  normalizeProfile,
  type ProfilePackage,
} from "./schema.js";

/** Resolve relative local profile sources against their scope root. */
export function profileMutationSource(pkg: ProfilePackage, cwd: string): string {
  const source = getEffectivePackageSource(pkg);
  if (
    getPackageSourceKind(source) !== "local" ||
    !(
      source.startsWith("./") ||
      source.startsWith("../") ||
      source.startsWith(".\\") ||
      source.startsWith("..\\")
    )
  ) {
    return source;
  }
  const root = pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  return resolve(root, source.replace(/\\/g, "/"));
}

function packageSettingsMatch(entry: PackageSource, pkg: InstalledPackage, cwd: string): boolean {
  const root = pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
  return (
    normalizePackageIdentity(packageSourceString(entry), { cwd: root }) ===
    normalizePackageIdentity(pkg.source, {
      ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
      cwd: root,
    })
  );
}

function packageRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return /(?:^|[\\/])package\.json$/i.test(path) ? dirname(path) : path;
}

async function resolveInstalledGitCommit(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string | undefined> {
  const cwd = packageRoot(pkg.resolvedPath);
  if (!pi || !cwd) return undefined;
  try {
    const result = await pi.exec("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 5_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const commit = result.stdout.trim();
    return result.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
      ? commit
      : undefined;
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return undefined;
  }
}

async function toProfilePackage(
  pkg: InstalledPackage,
  configured: PackageSource | undefined,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ProfilePackage> {
  const configuredSource = configured ? packageSourceString(configured) : pkg.source;
  const sourceKind = getPackageSourceKind(configuredSource);
  const parsed = parsePackageNameAndVersion(configuredSource);
  const manifest = await readPackageManifestSnapshot(pkg.resolvedPath);
  const installedVersion =
    manifest?.version ?? (isExactNpmVersion(pkg.version) ? pkg.version : undefined);
  const configuredGit =
    sourceKind === "git" ? splitGitRepoAndRef(stripGitSourcePrefix(configuredSource)) : undefined;
  const installedCommit =
    sourceKind === "git" ? await resolveInstalledGitCommit(pkg, ctx, pi) : undefined;
  const filters =
    configured && typeof configured === "object" && Array.isArray(configured.extensions)
      ? configured.extensions.filter((filter): filter is string => typeof filter === "string")
      : undefined;
  const packageSettings =
    configured && typeof configured === "object"
      ? Object.fromEntries(
          Object.entries(configured)
            .filter(([key]) => key !== "source" && key !== "extensions")
            .map(([key, value]) => [key, structuredClone(value)])
        )
      : undefined;

  // Saved/exported profiles are snapshots. Strip mutable npm ranges and git
  // refs when the installed artifact gives us an exact reproducible target.
  const source =
    sourceKind === "npm" && installedVersion
      ? `npm:${parsed.name}`
      : sourceKind === "git" && installedCommit && configuredGit
        ? `${configuredSource.startsWith("git:") ? "git:" : configuredSource.startsWith("git+") ? "git+" : ""}${configuredGit.repo}`
        : configuredSource;
  const version = sourceKind === "npm" ? (installedVersion ?? parsed.version) : undefined;
  const ref = sourceKind === "git" ? (installedCommit ?? configuredGit?.ref) : undefined;
  const locked =
    (sourceKind === "npm" && Boolean(installedVersion)) ||
    (sourceKind === "git" && Boolean(installedCommit));

  return {
    source,
    scope: pkg.scope,
    ...(version ? { version } : {}),
    ...(ref ? { ref } : {}),
    ...(locked ? { resolution: "locked" as const } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(packageSettings && Object.keys(packageSettings).length > 0 ? { packageSettings } : {}),
    ...(manifest ? { manifestFingerprint: manifest.fingerprint } : {}),
  };
}

export async function getCurrentProfile(
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ExtmgrProfile> {
  const packages = await getInstalledPackagesAllScopes(ctx);
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: isProjectTrusted(ctx),
  });
  const global = settings.getGlobalSettings();
  const project = settings.getProjectSettings();
  const profiles = await Promise.all(
    packages.map((pkg) => {
      const scoped = pkg.scope === "project" ? project : global;
      const configured = scoped.packages?.find((entry) =>
        packageSettingsMatch(entry, pkg, ctx.cwd)
      );
      return toProfilePackage(pkg, configured, ctx, pi);
    })
  );
  return normalizeProfile({ name: "current", packages: profiles });
}

interface InstalledRuntimeTarget {
  pkg: InstalledPackage;
  version?: string;
  gitCommit?: string;
}

async function describeInstalledRuntimeTargets(
  installed: InstalledPackage[],
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<InstalledRuntimeTarget[]> {
  return Promise.all(
    installed.map(async (pkg) => {
      const snapshot = await readPackageManifestSnapshot(pkg.resolvedPath);
      const sourceVersion = parsePackageNameAndVersion(pkg.source).version;
      const version =
        snapshot?.version ??
        (isExactNpmVersion(pkg.version) ? pkg.version : undefined) ??
        (isExactNpmVersion(sourceVersion) ? sourceVersion : undefined);
      const gitCommit =
        getPackageSourceKind(pkg.source) === "git"
          ? await resolveInstalledGitCommit(pkg, ctx, pi)
          : undefined;
      return {
        pkg,
        ...(version ? { version } : {}),
        ...(gitCommit ? { gitCommit } : {}),
      };
    })
  );
}

function installedRuntimeMatchesProfileTarget(
  runtime: InstalledRuntimeTarget,
  target: ProfilePackage,
  ctx: ExtensionCommandContext
): boolean {
  const { pkg: candidate } = runtime;
  if (candidate.scope !== target.scope) return false;
  const expectedIdentity = getProfilePackageIdentity(target, {
    projectCwd: ctx.cwd,
    globalCwd: getAgentDir(),
  });
  const actualIdentity = normalizePackageIdentity(candidate.source, {
    ...(candidate.resolvedPath ? { resolvedPath: candidate.resolvedPath } : {}),
    cwd: candidate.scope === "project" ? getProjectConfigDir(ctx.cwd) : getAgentDir(),
  });
  if (actualIdentity !== expectedIdentity) return false;

  const expectedSource = getEffectivePackageSource(target);
  const expectedKind = getPackageSourceKind(expectedSource);
  if (expectedKind === "npm") {
    const expectedVersion = parsePackageNameAndVersion(expectedSource).version;
    return !expectedVersion || runtime.version === expectedVersion;
  }
  if (expectedKind === "git") {
    const expectedRef = splitGitRepoAndRef(stripGitSourcePrefix(expectedSource)).ref;
    if (!expectedRef) return true;
    if (runtime.gitCommit) return runtime.gitCommit === expectedRef;
    const configuredRef = splitGitRepoAndRef(stripGitSourcePrefix(candidate.source)).ref;
    return configuredRef === expectedRef;
  }
  return true;
}

export async function calculateProfileDiagnostics(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<ProfilePackageDiagnostic[]> {
  const installed = await getInstalledPackagesAllScopes(ctx);
  const [runtimeTargets, compatibility] = await Promise.all([
    describeInstalledRuntimeTargets(installed, ctx, pi),
    inspectInstalledPackageCompatibility(installed, { piVersion: VERSION }),
  ]);
  return desired.packages.map((pkg) => {
    const source = getEffectivePackageSource(pkg);
    const runtime = runtimeTargets.find((candidate) =>
      installedRuntimeMatchesProfileTarget(candidate, pkg, ctx)
    );
    const local = runtime
      ? compatibility.find(
          (candidate) =>
            candidate.scope === runtime.pkg.scope && candidate.source === runtime.pkg.source
        )
      : undefined;
    const compatibilityStatus =
      local && (local.node === "incompatible" || local.pi === "incompatible")
        ? "failed"
        : !local || local.node === "unknown" || local.pi === "unknown"
          ? "unknown"
          : "verified";
    return {
      source,
      scope: pkg.scope,
      compatibility: compatibilityStatus,
      // Pi's public package APIs do not expose artifact integrity evidence.
      integrity: "unknown",
      notes: [
        ...(!local
          ? ["exact target is not installed; compatibility cannot be established before install"]
          : local.reasons),
        "artifact integrity is unavailable through Pi public APIs",
      ],
    };
  });
}

/** Report profile targets that are not installed at their exact version/ref. */
export async function verifyInstalledTargets(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string[]> {
  const installed = await getInstalledPackagesAllScopes(ctx);
  const runtimeTargets = await describeInstalledRuntimeTargets(installed, ctx, pi);
  const missing: string[] = [];
  for (const pkg of desired.packages) {
    const source = getEffectivePackageSource(pkg);
    if (
      !runtimeTargets.some((candidate) => installedRuntimeMatchesProfileTarget(candidate, pkg, ctx))
    ) {
      missing.push(`${source} (${pkg.scope})`);
    }
  }
  return missing;
}

export function profileSourcesMatch(
  left: ProfilePackage,
  right: ProfilePackage,
  ctx: ExtensionCommandContext
): boolean {
  const leftSource = getEffectivePackageSource(left);
  const rightSource = getEffectivePackageSource(right);
  const sameSource =
    getPackageSourceKind(leftSource) === "local" && getPackageSourceKind(rightSource) === "local"
      ? getProfilePackageIdentity(left, {
          projectCwd: ctx.cwd,
          globalCwd: getAgentDir(),
        }) ===
        getProfilePackageIdentity(right, {
          projectCwd: ctx.cwd,
          globalCwd: getAgentDir(),
        })
      : leftSource === rightSource;
  return left.scope === right.scope && sameSource;
}

/** Compare desired configuration against the live state, reporting drift. */
export async function verifyFinalProfile(
  desired: ExtmgrProfile,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI
): Promise<string[]> {
  const actual = await getCurrentProfile(ctx, pi);
  const drift: string[] = [];
  for (const pkg of desired.packages) {
    const match = actual.packages.find(
      (candidate) =>
        profileSourcesMatch(candidate, pkg, ctx) &&
        JSON.stringify(candidate.filters) === JSON.stringify(pkg.filters) &&
        (pkg.packageSettings === undefined ||
          JSON.stringify(candidate.packageSettings ?? {}) === JSON.stringify(pkg.packageSettings))
    );
    if (!match) drift.push(`${getEffectivePackageSource(pkg)} (${pkg.scope})`);
  }
  for (const pkg of actual.packages) {
    const match = desired.packages.some((candidate) => profileSourcesMatch(candidate, pkg, ctx));
    if (!match) drift.push(`unexpected ${getEffectivePackageSource(pkg)} (${pkg.scope})`);
  }
  return [...new Set(drift)];
}
