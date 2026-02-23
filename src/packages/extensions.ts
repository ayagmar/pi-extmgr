import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, PackageExtensionEntry, Scope, State } from "../types/index.js";
import { parseNpmSource } from "../utils/format.js";
import { fileExists, readSummary } from "../utils/fs.js";

interface PackageSettingsObject {
  source: string;
  extensions?: string[];
}

interface SettingsFile {
  packages?: (string | PackageSettingsObject)[];
}

const execFileAsync = promisify(execFile);
let globalNpmRootCache: string | null | undefined;

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized;
}

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

async function getGlobalNpmRoot(): Promise<string | undefined> {
  if (globalNpmRootCache !== undefined) {
    return globalNpmRootCache ?? undefined;
  }

  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      timeout: 2_000,
      windowsHide: true,
    });
    const root = stdout.trim();
    globalNpmRootCache = root || null;
  } catch {
    globalNpmRootCache = null;
  }

  return globalNpmRootCache ?? undefined;
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

  const npmGlobalRoot = await getGlobalNpmRoot();
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

function getSettingsPath(scope: Scope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".pi", "settings.json");
  }
  return join(getAgentDir(), "settings.json");
}

async function readSettingsFile(
  path: string,
  options?: { strict?: boolean }
): Promise<SettingsFile> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (options?.strict) {
        throw new Error(
          `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (options?.strict) {
        throw new Error(`Invalid settings format in ${path}: expected a JSON object`);
      }
      return {};
    }

    return parsed as SettingsFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    if (options?.strict) {
      throw error;
    }

    return {};
  }
}

async function writeSettingsFile(path: string, settings: SettingsFile): Promise<void> {
  const settingsDir = dirname(path);
  await mkdir(settingsDir, { recursive: true });

  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, path);
  } catch {
    await writeFile(path, content, "utf8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function safeMatchesGlob(targetPath: string, pattern: string): boolean {
  try {
    return matchesGlob(targetPath, pattern);
  } catch {
    return false;
  }
}

function matchesFilterPattern(targetPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern.trim());
  if (!normalizedPattern) return false;
  if (targetPath === normalizedPattern) return true;

  return safeMatchesGlob(targetPath, normalizedPattern);
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

async function getPackageExtensionState(
  packageSource: string,
  extensionPath: string,
  scope: Scope,
  cwd: string
): Promise<State> {
  const settingsPath = getSettingsPath(scope, cwd);
  const settings = await readSettingsFile(settingsPath);
  const packages = settings.packages ?? [];
  const normalizedSource = normalizeSource(packageSource);

  const entry = packages.find((pkg) => {
    if (typeof pkg === "string") {
      return normalizeSource(pkg) === normalizedSource;
    }
    return normalizeSource(pkg.source) === normalizedSource;
  });

  if (!entry || typeof entry === "string") {
    return "enabled";
  }

  return getPackageFilterState(entry.extensions, extensionPath);
}

function isExtensionEntrypointPath(path: string): boolean {
  return /\.(ts|js)$/i.test(path);
}

function hasGlobMagic(path: string): boolean {
  return /[*?{}[\]]/.test(path);
}

function isSafeRelativePath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.includes("/../");
}

function selectDirectoryFiles(allFiles: string[], directoryPath: string): string[] {
  const prefix = `${directoryPath}/`;
  return allFiles.filter((file) => file.startsWith(prefix));
}

function applySelection(selected: Set<string>, files: Iterable<string>, exclude: boolean): void {
  for (const file of files) {
    if (exclude) {
      selected.delete(file);
    } else {
      selected.add(file);
    }
  }
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
  const selected = new Set<string>();
  const allFiles = await collectExtensionFilesFromDir(packageRoot, packageRoot);

  for (const rawToken of entries) {
    const token = rawToken.trim();
    if (!token) continue;

    const exclude = token.startsWith("!");
    const normalizedToken = normalizeRelativePath(exclude ? token.slice(1) : token);
    const pattern = normalizedToken.replace(/[\\/]+$/g, "");
    if (!isSafeRelativePath(pattern)) {
      continue;
    }

    if (hasGlobMagic(pattern)) {
      const matchedFiles = allFiles.filter((file) => matchesFilterPattern(file, pattern));
      applySelection(selected, matchedFiles, exclude);
      continue;
    }

    const directoryFiles = selectDirectoryFiles(allFiles, pattern);
    if (directoryFiles.length > 0) {
      applySelection(selected, directoryFiles, exclude);
      continue;
    }

    if (isExtensionEntrypointPath(pattern)) {
      applySelection(selected, [pattern], exclude);
    }
  }

  return Array.from(selected).sort((a, b) => a.localeCompare(b));
}

export async function resolveManifestExtensionEntrypoints(
  packageRoot: string
): Promise<string[] | undefined> {
  const packageJsonPath = join(packageRoot, "package.json");

  let parsed: { pi?: { extensions?: unknown } };
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
  } catch {
    return undefined;
  }

  const extensions = parsed.pi?.extensions;
  if (!Array.isArray(extensions)) {
    return undefined;
  }

  const entries = extensions.filter((value): value is string => typeof value === "string");
  return resolveManifestExtensionEntries(packageRoot, entries);
}

async function discoverEntrypoints(packageRoot: string): Promise<string[]> {
  const manifestEntrypoints = await resolveManifestExtensionEntrypoints(packageRoot);
  if (manifestEntrypoints !== undefined) {
    return manifestEntrypoints;
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

export async function discoverPackageExtensions(
  packages: InstalledPackage[],
  cwd: string
): Promise<PackageExtensionEntry[]> {
  const entries: PackageExtensionEntry[] = [];

  for (const pkg of packages) {
    const packageRoot = await toPackageRoot(pkg, cwd);
    if (!packageRoot) continue;

    const extensionPaths = await discoverEntrypoints(packageRoot);
    for (const extensionPath of extensionPaths) {
      const normalizedPath = normalizeRelativePath(extensionPath);
      const absolutePath = resolve(packageRoot, extensionPath);
      const summary = (await fileExists(absolutePath))
        ? await readSummary(absolutePath)
        : "package extension";
      const state = await getPackageExtensionState(pkg.source, normalizedPath, pkg.scope, cwd);

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
  cwd: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const settingsPath = getSettingsPath(scope, cwd);
    const settings = await readSettingsFile(settingsPath, { strict: true });

    const normalizedSource = normalizeSource(packageSource);
    const normalizedPath = normalizeRelativePath(extensionPath);
    const marker = `${target === "enabled" ? "+" : "-"}${normalizedPath}`;

    const packages = [...(settings.packages ?? [])];
    let index = packages.findIndex((pkg) => {
      if (typeof pkg === "string") {
        return normalizeSource(pkg) === normalizedSource;
      }
      return normalizeSource(pkg.source) === normalizedSource;
    });

    let packageEntry: PackageSettingsObject;
    if (index === -1) {
      packageEntry = { source: packageSource, extensions: [marker] };
      packages.push(packageEntry);
      index = packages.length - 1;
    } else {
      const existing = packages[index];
      if (typeof existing === "string") {
        packageEntry = { source: existing, extensions: [] };
      } else if (existing && typeof existing.source === "string") {
        packageEntry = {
          source: existing.source,
          extensions: Array.isArray(existing.extensions) ? [...existing.extensions] : [],
        };
      } else {
        packageEntry = { source: packageSource, extensions: [] };
      }

      packageEntry.extensions = (packageEntry.extensions ?? []).filter((token) => {
        if (typeof token !== "string") return false;
        if (token[0] !== "+" && token[0] !== "-") return true;
        return normalizeRelativePath(token.slice(1)) !== normalizedPath;
      });
      packageEntry.extensions.push(marker);
      packages[index] = packageEntry;
    }

    settings.packages = packages;

    await writeSettingsFile(settingsPath, settings);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
