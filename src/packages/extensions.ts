import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, PackageExtensionEntry, Scope, State } from "../types/index.js";
import { fileExists, readSummary } from "../utils/fs.js";

interface PackageSettingsObject {
  source: string;
  extensions?: string[];
}

interface SettingsFile {
  packages?: (string | PackageSettingsObject)[];
}

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

function toPackageRoot(pkg: InstalledPackage, cwd: string): string | undefined {
  if (pkg.resolvedPath) {
    return normalizePackageRootCandidate(pkg.resolvedPath);
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

function getPackageFilterState(filters: string[] | undefined, extensionPath: string): State {
  if (!filters || filters.length === 0) {
    return "enabled";
  }

  const normalizedTarget = normalizeRelativePath(extensionPath);
  let state: State = "enabled";

  for (const token of filters) {
    if (!token || (token[0] !== "+" && token[0] !== "-")) continue;
    const sign = token[0];
    const path = normalizeRelativePath(token.slice(1));
    if (path !== normalizedTarget) continue;
    state = sign === "+" ? "enabled" : "disabled";
  }

  return state;
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

async function discoverEntrypoints(packageRoot: string): Promise<string[]> {
  const packageJsonPath = join(packageRoot, "package.json");
  let manifestExtensions: string[] | undefined;

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
    const ext = parsed.pi?.extensions;
    if (Array.isArray(ext)) {
      const entries = ext.filter((value): value is string => typeof value === "string");
      if (entries.length > 0) {
        manifestExtensions = entries;
      }
    }
  } catch {
    // Ignore invalid/missing package.json and fall back.
  }

  if (manifestExtensions && manifestExtensions.length > 0) {
    return manifestExtensions.map((entry) => normalizeRelativePath(entry));
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
    const packageRoot = toPackageRoot(pkg, cwd);
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

export function toProjectRelativePath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : normalizeRelativePath(rel);
}
