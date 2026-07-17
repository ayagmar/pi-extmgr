import { execFile } from "node:child_process";
import { type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import {
  type InstalledPackage,
  type PackageExtensionEntry,
  type Scope,
  type State,
} from "../types/index.js";
import { parseNpmSource } from "../utils/format.js";
import { fileExists, readSummary } from "../utils/fs.js";
import {
  matchesFilterPattern,
  normalizeRelativePath,
  resolveRelativePathSelection,
} from "../utils/relative-path-selection.js";
import { resolveConfiguredNpmRootCommand } from "../utils/npm-exec.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";

interface PackageSettingsObject {
  source: string;
  extensions?: string[];
  [key: string]: unknown;
}

export interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  pi?: {
    extensions?: unknown;
  };
}

const execFileAsync = promisify(execFile);
let globalNpmRootCache: { key: string; root: string | null } | undefined;
const packageEntrypointCache = new Map<string, Promise<string[]>>();

function normalizeSource(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

function normalizePackageRootCandidate(candidate: string): string {
  const resolved = resolve(candidate);

  if (/(?:^|[\\/])package\.json$/i.test(resolved) || /\.(?:[cm]?[jt]s)$/i.test(resolved)) {
    return dirname(resolved);
  }

  return resolved;
}

async function getGlobalNpmRoot(cwd: string): Promise<string | undefined> {
  let npmCommand: ReturnType<typeof resolveConfiguredNpmRootCommand>;
  try {
    npmCommand = resolveConfiguredNpmRootCommand(cwd);
  } catch {
    return undefined;
  }

  const cacheKey = [npmCommand.command, ...npmCommand.args].join("\0");

  if (globalNpmRootCache?.key === cacheKey) {
    return globalNpmRootCache.root ?? undefined;
  }

  try {
    const { stdout } = await execFileAsync(npmCommand.command, npmCommand.args, {
      timeout: 2_000,
      windowsHide: true,
    });
    const root = npmCommand.getRoot(stdout);
    globalNpmRootCache = { key: cacheKey, root: root || null };
  } catch {
    globalNpmRootCache = { key: cacheKey, root: null };
  }

  return globalNpmRootCache.root ?? undefined;
}

async function resolveNpmPackageRoot(
  pkg: InstalledPackage,
  cwd: string
): Promise<string | undefined> {
  const parsed = parseNpmSource(pkg.source);
  if (!parsed?.name) {
    return undefined;
  }

  const packageName = parsed.name;
  const projectCandidates = [
    join(cwd, ".pi", "npm", "node_modules", packageName),
    join(cwd, "node_modules", packageName),
  ];

  const packageDir = process.env.PI_PACKAGE_DIR || join(homedir(), ".pi", "agent");
  const globalCandidates = [join(packageDir, "npm", "node_modules", packageName)];

  const npmGlobalRoot = await getGlobalNpmRoot(cwd);
  if (npmGlobalRoot) {
    globalCandidates.unshift(join(npmGlobalRoot, packageName));
  }

  const candidates =
    pkg.scope === "project" ? projectCandidates : [...globalCandidates, ...projectCandidates];

  for (const candidate of candidates) {
    if (await fileExists(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return undefined;
}

async function toPackageRoot(pkg: InstalledPackage, cwd: string): Promise<string | undefined> {
  if (pkg.resolvedPath) {
    return normalizePackageRootCandidate(pkg.resolvedPath);
  }

  if (pkg.source.startsWith("npm:")) {
    return resolveNpmPackageRoot(pkg, cwd);
  }

  if (pkg.source.startsWith("file://")) {
    try {
      return normalizePackageRootCandidate(fileURLToPath(pkg.source));
    } catch {
      return undefined;
    }
  }

  if (
    pkg.source.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(pkg.source) ||
    pkg.source.startsWith("\\\\")
  ) {
    return normalizePackageRootCandidate(pkg.source);
  }

  if (
    pkg.source.startsWith("./") ||
    pkg.source.startsWith("../") ||
    pkg.source.startsWith(".\\") ||
    pkg.source.startsWith("..\\")
  ) {
    return normalizePackageRootCandidate(resolve(cwd, pkg.source));
  }

  if (pkg.source.startsWith("~/")) {
    return normalizePackageRootCandidate(join(homedir(), pkg.source.slice(2)));
  }

  return undefined;
}

function createSettingsManager(cwd: string, projectTrusted: boolean): SettingsManager {
  return SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
}

function getScopedPackages(
  settings: SettingsManager,
  scope: Scope
): (string | PackageSettingsObject)[] {
  const packages =
    scope === "project" ? settings.getProjectSettings().packages : settings.getPackages();
  return packages ? [...packages] : [];
}

function findPackageSettingsIndex(
  packages: (string | PackageSettingsObject)[],
  normalizedSource: string
): number {
  return packages.findIndex((pkg) => {
    if (typeof pkg === "string") {
      return normalizeSource(pkg) === normalizedSource;
    }
    return normalizeSource(pkg.source) === normalizedSource;
  });
}

function toPackageSettingsObject(
  existing: string | PackageSettingsObject | undefined,
  packageSource: string
): PackageSettingsObject {
  if (typeof existing === "string") {
    return { source: existing };
  }

  if (existing && typeof existing.source === "string") {
    return {
      ...structuredClone(existing),
      source: existing.source,
      ...(Array.isArray(existing.extensions) ? { extensions: [...existing.extensions] } : {}),
    };
  }

  return { source: packageSource };
}

function updateExtensionMarkers(
  existingTokens: string[] | undefined,
  changes: ReadonlyMap<string, State>
): string[] {
  const nextTokens: string[] = [];

  for (const token of existingTokens ?? []) {
    if (typeof token !== "string") {
      continue;
    }

    if (token[0] !== "+" && token[0] !== "-") {
      nextTokens.push(token);
      continue;
    }

    const tokenPath = normalizeRelativePath(token.slice(1));
    if (!changes.has(tokenPath)) {
      nextTokens.push(token);
    }
  }

  for (const [extensionPath, target] of Array.from(changes.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const baseFilters =
      nextTokens.length > 0
        ? nextTokens
        : existingTokens && existingTokens.length === 0
          ? []
          : undefined;
    const baseState = getPackageFilterState(baseFilters, extensionPath);
    if (target !== baseState) {
      nextTokens.push(`${target === "enabled" ? "+" : "-"}${extensionPath}`);
    }
  }

  return nextTokens;
}

export async function validatePackageExtensionSettings(
  scope: Scope,
  cwd: string,
  projectTrusted = false
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const settings = createSettingsManager(cwd, projectTrusted);
    throwIfSettingsErrors(settings, "Package extension configuration");
    getScopedPackages(settings, scope);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyPackageExtensionStateChanges(
  packageSource: string,
  scope: Scope,
  changes: readonly { extensionPath: string; target: State }[],
  cwd: string,
  projectTrusted = false
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (changes.length === 0) {
      return { ok: true };
    }

    const settings = createSettingsManager(cwd, projectTrusted);
    throwIfSettingsErrors(settings, "Package extension configuration");
    const normalizedSource = normalizeSource(packageSource);
    const packages = getScopedPackages(settings, scope);
    const index = findPackageSettingsIndex(packages, normalizedSource);
    const packageEntry = toPackageSettingsObject(packages[index], packageSource);

    const normalizedChanges = new Map<string, State>();
    for (const change of changes) {
      normalizedChanges.set(normalizeRelativePath(change.extensionPath), change.target);
    }

    packageEntry.extensions = updateExtensionMarkers(packageEntry.extensions, normalizedChanges);

    if (packageEntry.extensions.length === 0) {
      delete packageEntry.extensions;
    }
    const normalizedPackageEntry =
      Object.keys(packageEntry).length > 1 ? packageEntry : packageEntry.source;

    if (index === -1) {
      packages.push(normalizedPackageEntry);
    } else {
      packages[index] = normalizedPackageEntry;
    }

    if (scope === "project") {
      settings.setProjectPackages(packages);
    } else {
      settings.setPackages(packages);
    }
    await settings.flush();
    throwIfSettingsErrors(settings, "Package extension configuration");

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getPackageFilterState(filters: string[] | undefined, extensionPath: string): State {
  // Omitted key => all enabled (pi default).
  if (filters === undefined) {
    return "enabled";
  }

  // Explicit empty array => load none.
  if (filters.length === 0) {
    return "disabled";
  }

  const normalizedTarget = normalizeRelativePath(extensionPath);
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  let markerOverride: State | undefined;

  for (const rawToken of filters) {
    const token = rawToken.trim();
    if (!token) continue;

    const prefix = token[0];

    if (prefix === "+" || prefix === "-") {
      const markerPath = normalizeRelativePath(token.slice(1));
      if (markerPath === normalizedTarget) {
        markerOverride = prefix === "+" ? "enabled" : "disabled";
      }
      continue;
    }

    if (prefix === "!") {
      const pattern = normalizeRelativePath(token.slice(1));
      if (pattern) {
        excludePatterns.push(pattern);
      }
      continue;
    }

    const include = normalizeRelativePath(token);
    if (include) {
      includePatterns.push(include);
    }
  }

  let enabled =
    includePatterns.length === 0 ||
    includePatterns.some((p) => matchesFilterPattern(normalizedTarget, p));

  if (enabled && excludePatterns.some((p) => matchesFilterPattern(normalizedTarget, p))) {
    enabled = false;
  }

  if (markerOverride !== undefined) {
    enabled = markerOverride === "enabled";
  }

  return enabled ? "enabled" : "disabled";
}

async function readPackageFilterMap(
  scope: Scope,
  cwd: string,
  projectTrusted: boolean
): Promise<Map<string, string[] | undefined>> {
  const settings = createSettingsManager(cwd, projectTrusted);
  const packages = getScopedPackages(settings, scope);
  const filterMap = new Map<string, string[] | undefined>();

  for (const entry of packages) {
    if (typeof entry === "string") {
      filterMap.set(normalizeSource(entry), undefined);
      continue;
    }

    if (typeof entry.source !== "string") {
      continue;
    }

    filterMap.set(
      normalizeSource(entry.source),
      Array.isArray(entry.extensions) ? entry.extensions : undefined
    );
  }

  return filterMap;
}

function isExtensionEntrypointPath(path: string): boolean {
  return /\.(ts|js)$/i.test(path);
}

async function collectExtensionFilesFromDir(
  packageRoot: string,
  startDir: string
): Promise<string[]> {
  const collected: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(startDir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    const absolutePath = join(startDir, entry.name);

    if (entry.isDirectory()) {
      collected.push(...(await collectExtensionFilesFromDir(packageRoot, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = normalizeRelativePath(relative(packageRoot, absolutePath));
    if (isExtensionEntrypointPath(relativePath)) {
      collected.push(relativePath);
    }
  }

  return collected;
}

async function resolveManifestExtensionEntries(
  packageRoot: string,
  entries: string[]
): Promise<string[]> {
  const allFiles = await collectExtensionFilesFromDir(packageRoot, packageRoot);
  return resolveRelativePathSelection(
    allFiles,
    entries,
    (path, files) => isExtensionEntrypointPath(path) && files.includes(path)
  );
}

export async function readPackageManifest(
  packageRoot: string
): Promise<PackageManifest | undefined> {
  const packageJsonPath = join(packageRoot, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as PackageManifest;
  } catch {
    return undefined;
  }
}

export async function resolveManifestExtensionEntrypoints(
  packageRoot: string,
  manifest?: PackageManifest
): Promise<string[] | undefined> {
  const parsed = manifest ?? (await readPackageManifest(packageRoot));
  const extensions = parsed?.pi?.extensions;
  if (!Array.isArray(extensions)) {
    return undefined;
  }

  const entries = extensions.filter((value): value is string => typeof value === "string");
  return resolveManifestExtensionEntries(packageRoot, entries);
}

async function resolveConventionExtensionEntrypoints(packageRoot: string): Promise<string[]> {
  const extensionsDir = join(packageRoot, "extensions");
  return collectExtensionFilesFromDir(packageRoot, extensionsDir);
}

async function discoverPackageExtensionEntrypointsUncached(
  packageRoot: string,
  options?: {
    allowConventionDirectory?: boolean;
    allowRootIndexFallback?: boolean;
  }
): Promise<string[]> {
  const manifest = await readPackageManifest(packageRoot);
  const manifestEntrypoints = await resolveManifestExtensionEntrypoints(packageRoot, manifest);
  if (manifestEntrypoints !== undefined) {
    return manifestEntrypoints;
  }

  if (options?.allowConventionDirectory !== false) {
    const conventionEntrypoints = await resolveConventionExtensionEntrypoints(packageRoot);
    if (conventionEntrypoints.length > 0) {
      return conventionEntrypoints.sort((a, b) => a.localeCompare(b));
    }
  }

  if (options?.allowRootIndexFallback === false) {
    return [];
  }

  const indexTs = join(packageRoot, "index.ts");
  if (await fileExists(indexTs)) {
    return ["index.ts"];
  }

  const indexJs = join(packageRoot, "index.js");
  if (await fileExists(indexJs)) {
    return ["index.js"];
  }

  return [];
}

function getEntrypointCacheKey(
  packageRoot: string,
  options?: { allowConventionDirectory?: boolean; allowRootIndexFallback?: boolean }
): string {
  return `${resolve(packageRoot)}\0${options?.allowConventionDirectory !== false}\0${options?.allowRootIndexFallback !== false}`;
}

/** Clear the in-memory entrypoint cache, useful after package installation or removal. */
export function clearPackageEntrypointCache(): void {
  packageEntrypointCache.clear();
}

export function discoverPackageExtensionEntrypoints(
  packageRoot: string,
  options?: {
    allowConventionDirectory?: boolean;
    allowRootIndexFallback?: boolean;
  }
): Promise<string[]> {
  const key = getEntrypointCacheKey(packageRoot, options);
  const cached = packageEntrypointCache.get(key);
  if (cached) return cached;

  const result = discoverPackageExtensionEntrypointsUncached(packageRoot, options);
  packageEntrypointCache.set(key, result);
  result.catch(() => packageEntrypointCache.delete(key));
  return result;
}

export async function discoverPackageExtensions(
  packages: InstalledPackage[],
  cwd: string,
  options?: { projectTrusted?: boolean }
): Promise<PackageExtensionEntry[]> {
  const entries: PackageExtensionEntry[] = [];
  const projectTrusted = options?.projectTrusted ?? false;
  const [globalFilterMap, projectFilterMap] = await Promise.all([
    readPackageFilterMap("global", cwd, projectTrusted),
    readPackageFilterMap("project", cwd, projectTrusted),
  ]);

  for (const pkg of packages) {
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: createSettingsManager(cwd, projectTrusted),
    });
    let resolvedResources: ResolvedResource[] = [];
    try {
      if (!pkg.resolvedPath) throw new Error("package path is not characterized");
      const resolved = await packageManager.resolveExtensionSources([pkg.source], {
        local: pkg.scope === "project",
      });
      resolvedResources = resolved.extensions.filter(
        (resource) =>
          resource.metadata.scope === (pkg.scope === "project" ? "project" : "user") &&
          normalizeSource(resource.metadata.source) === normalizeSource(pkg.source)
      );
    } catch {
      // Compatibility adapter for package records not representable by Pi's resolver.
    }

    if (resolvedResources.length > 0) {
      for (const resource of resolvedResources) {
        const packageRoot = resource.metadata.baseDir;
        const extensionPath = packageRoot
          ? normalizeRelativePath(relative(packageRoot, resource.path))
          : normalizeRelativePath(resource.path);
        entries.push({
          id: `pkg-ext:${pkg.scope}:${pkg.source}:${extensionPath}`,
          packageSource: pkg.source,
          packageName: pkg.name,
          packageScope: pkg.scope,
          extensionPath,
          absolutePath: resource.path,
          displayName: `${pkg.name}/${extensionPath}`,
          summary: (await fileExists(resource.path))
            ? await readSummary(resource.path)
            : "package extension",
          state: resource.enabled ? "enabled" : "disabled",
        });
      }
      continue;
    }

    const packageRoot = await toPackageRoot(pkg, cwd);
    if (!packageRoot) continue;

    const packageFilters =
      (pkg.scope === "global" ? globalFilterMap : projectFilterMap).get(
        normalizeSource(pkg.source)
      ) ?? undefined;
    const extensionPaths = await discoverPackageExtensionEntrypoints(packageRoot);
    for (const extensionPath of extensionPaths) {
      const normalizedPath = normalizeRelativePath(extensionPath);
      const absolutePath = resolve(packageRoot, extensionPath);
      const summary = (await fileExists(absolutePath))
        ? await readSummary(absolutePath)
        : "package extension";
      const state = getPackageFilterState(packageFilters, normalizedPath);

      entries.push({
        id: `pkg-ext:${pkg.scope}:${pkg.source}:${normalizedPath}`,
        packageSource: pkg.source,
        packageName: pkg.name,
        packageScope: pkg.scope,
        extensionPath: normalizedPath,
        absolutePath,
        displayName: `${pkg.name}/${normalizedPath}`,
        summary,
        state,
      });
    }
  }

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

export async function setPackageExtensionState(
  packageSource: string,
  extensionPath: string,
  scope: Scope,
  target: State,
  cwd: string,
  projectTrusted = false
): Promise<{ ok: true } | { ok: false; error: string }> {
  return applyPackageExtensionStateChanges(
    packageSource,
    scope,
    [{ extensionPath, target }],
    cwd,
    projectTrusted
  );
}
