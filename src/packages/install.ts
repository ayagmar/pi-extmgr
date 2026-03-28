/**
 * Package installation logic
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProgressEvent,
} from "@mariozechner/pi-coding-agent";
import { TIMEOUTS } from "../constants.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import { normalizePackageSource } from "../utils/format.js";
import { fileExists } from "../utils/fs.js";
import { logPackageInstall } from "../utils/history.js";
import { tryOperation } from "../utils/mode.js";
import { fetchWithTimeout } from "../utils/network.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { execNpm } from "../utils/npm-exec.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { clearUpdatesAvailable } from "../utils/settings.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmAction, confirmReload, showProgress } from "../utils/ui-helpers.js";
import { getPackageCatalog } from "./catalog.js";
import { clearSearchCache } from "./discovery.js";
import { discoverPackageExtensionEntrypoints, readPackageManifest } from "./extensions.js";

export type InstallScope = "global" | "project";

export interface InstallOptions {
  scope?: InstallScope;
}

function getProgressMessage(event: ProgressEvent, fallback: string): string {
  return event.message?.trim() || fallback;
}

async function resolveInstallScope(
  ctx: ExtensionCommandContext,
  explicitScope?: InstallScope
): Promise<InstallScope | undefined> {
  if (explicitScope) return explicitScope;

  if (!ctx.hasUI) return "global";

  const choice = await ctx.ui.select("Install scope", [
    "Global (~/.pi/agent/settings.json)",
    "Project (.pi/settings.json)",
    "Cancel",
  ]);

  if (!choice || choice === "Cancel") return undefined;
  return choice.startsWith("Project") ? "project" : "global";
}

function getExtensionInstallDir(ctx: ExtensionCommandContext, scope: InstallScope): string {
  if (scope === "project") {
    return join(ctx.cwd, ".pi", "extensions");
  }
  return join(homedir(), ".pi", "agent", "extensions");
}

interface GithubUrlInfo {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

/**
 * Safely extracts regex match groups with validation
 */
function safeExtractGithubMatch(match: RegExpMatchArray | null): GithubUrlInfo | undefined {
  if (!match) return undefined;

  const [, owner, repo, branch, filePath] = match;

  if (!owner || !repo || !branch || !filePath) {
    return undefined;
  }

  return { owner, repo, branch, filePath };
}

async function ensureTarAvailable(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await pi.exec("tar", ["--version"], {
    timeout: 5_000,
    cwd: ctx.cwd,
  });

  if (result.code === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      "Standalone local installs require the `tar` command on PATH. Install tar or use managed package install instead.",
  };
}

async function hasStandaloneEntrypoint(packageRoot: string): Promise<boolean> {
  const entrypoints = await discoverPackageExtensionEntrypoints(packageRoot, {
    allowConventionDirectory: false,
  });

  for (const path of entrypoints) {
    if (await fileExists(join(packageRoot, path))) {
      return true;
    }
  }

  return false;
}

async function getStandaloneDependencyError(packageRoot: string): Promise<string | undefined> {
  const manifest = await readPackageManifest(packageRoot);
  const dependencies = manifest?.dependencies;
  if (!dependencies || typeof dependencies !== "object") {
    return undefined;
  }

  const missingDependencies: string[] = [];
  for (const dependencyName of Object.keys(dependencies)) {
    const dependencyPath = join(packageRoot, "node_modules", dependencyName);
    if (!(await fileExists(dependencyPath))) {
      missingDependencies.push(dependencyName);
    }
  }

  if (missingDependencies.length === 0) {
    return undefined;
  }

  const packageName = manifest?.name ?? "This package";
  return `${packageName} declares runtime dependencies that are not bundled for standalone install: ${missingDependencies.join(", ")}. Use managed install instead, or bundle dependencies in the package tarball.`;
}

async function cleanupStandaloneTempArtifacts(tempDir: string, extractDir?: string): Promise<void> {
  const paths = [extractDir, tempDir].filter((path): path is string => Boolean(path));

  await Promise.allSettled(
    paths.map(async (path) => {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[extmgr] Failed to remove temporary standalone install artifact at ${path}:`,
          error
        );
      }
    })
  );
}

export async function installPackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<void> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  // Check if it's a GitHub URL to a .ts file - handle as direct download
  const githubTsMatch = source.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.ts)$/
  );
  const githubInfo = safeExtractGithubMatch(githubTsMatch);
  if (githubInfo) {
    const rawUrl = `https://raw.githubusercontent.com/${githubInfo.owner}/${githubInfo.repo}/${githubInfo.branch}/${githubInfo.filePath}`;
    const fileName =
      githubInfo.filePath.split("/").pop() || `${githubInfo.owner}-${githubInfo.repo}.ts`;
    await installFromUrl(rawUrl, fileName, ctx, pi, { scope });
    return;
  }

  // Check if it's already a raw URL to a .ts file
  if (source.match(/^https:\/\/raw\.githubusercontent\.com\/.*\.ts$/)) {
    const fileName = source.split("/").pop() || "extension.ts";
    await installFromUrl(source, fileName, ctx, pi, { scope });
    return;
  }

  const normalized = normalizePackageSource(source);

  // Confirm installation
  const confirmed = await confirmAction(
    ctx,
    "Install Package",
    `Install ${normalized} (${scope})?`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  showProgress(ctx, "Installing", normalized);

  try {
    await runTaskWithLoader(
      ctx,
      {
        title: "Install Package",
        message: `Installing ${normalized}...`,
        cancellable: false,
        fallbackWithoutLoader: true,
      },
      async ({ setMessage }) => {
        await getPackageCatalog(ctx.cwd).install(normalized, scope, (event) => {
          setMessage(getProgressMessage(event, `Installing ${normalized}...`));
        });
        return undefined;
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorMsg = `Install failed:\n${message}`;
    logPackageInstall(pi, normalized, normalized, undefined, scope, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  clearSearchCache();
  logPackageInstall(pi, normalized, normalized, undefined, scope, true);
  success(ctx, `Installed ${normalized} (${scope})`);
  clearUpdatesAvailable(pi, ctx, [normalizePackageIdentity(normalized, { cwd: ctx.cwd })]);

  const reloaded = await confirmReload(ctx, "Package installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
}

export async function installFromUrl(
  url: string,
  fileName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<void> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const extensionDir = getExtensionInstallDir(ctx, scope);

  // Confirm installation
  const confirmed = await confirmAction(
    ctx,
    "Install from URL",
    `Download ${fileName} to ${scope} extensions?`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const result = await tryOperation(
    ctx,
    async () => {
      await mkdir(extensionDir, { recursive: true });
      notify(ctx, `Downloading ${fileName}...`, "info");

      const response = await fetchWithTimeout(url, TIMEOUTS.packageInstall);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();
      const destPath = join(extensionDir, fileName);
      await writeFile(destPath, content, "utf8");

      return { fileName, destPath };
    },
    "Installation failed"
  );

  if (!result) {
    logPackageInstall(pi, url, fileName, undefined, scope, false, "Installation failed");
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  const { fileName: name, destPath } = result;
  logPackageInstall(pi, url, name, undefined, scope, true);
  success(ctx, `Installed ${name} to:\n${destPath}`);

  const reloaded = await confirmReload(ctx, "Extension installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
}

/**
 * Safely parses package tarball information from npm view output
 */
function parsePackageInfo(viewOutput: string): { version: string; tarballUrl: string } | undefined {
  try {
    const pkgInfo = JSON.parse(viewOutput) as {
      version?: string;
      dist?: { tarball?: string };
    };
    const version = pkgInfo.version;
    const tarballUrl = pkgInfo.dist?.tarball;

    if (!version || !tarballUrl) {
      return undefined;
    }

    return { version, tarballUrl };
  } catch {
    return undefined;
  }
}

export async function installPackageLocally(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<void> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const extensionDir = getExtensionInstallDir(ctx, scope);

  // Confirm local installation
  const confirmed = await confirmAction(
    ctx,
    "Install Locally",
    `Download ${packageName} to ${scope} extensions?\n\nThis installs as a standalone extension (manual updates).`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const result = await tryOperation(
    ctx,
    async () => {
      await mkdir(extensionDir, { recursive: true });
      showProgress(ctx, "Fetching", packageName);

      const viewRes = await execNpm(pi, ["view", packageName, "--json"], ctx, {
        timeout: TIMEOUTS.fetchPackageInfo,
      });

      if (viewRes.code !== 0) {
        throw new Error(`Failed to fetch package info: ${viewRes.stderr || viewRes.stdout}`);
      }

      const pkgInfo = parsePackageInfo(viewRes.stdout);
      if (!pkgInfo) {
        throw new Error("No tarball URL found for package");
      }

      return pkgInfo;
    },
    "Failed to fetch package info"
  );

  if (!result) {
    logPackageInstall(
      pi,
      `npm:${packageName}`,
      packageName,
      undefined,
      scope,
      false,
      "Failed to fetch package info"
    );
    void updateExtmgrStatus(ctx, pi);
    return;
  }
  const { version, tarballUrl } = result;

  const tarAvailability = await ensureTarAvailable(pi, ctx);
  if (!tarAvailability.ok) {
    notifyError(ctx, tarAvailability.error);
    logPackageInstall(
      pi,
      `npm:${packageName}`,
      packageName,
      version,
      scope,
      false,
      tarAvailability.error
    );
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  // Download and extract
  const tempDir = join(extensionDir, ".temp");
  const extractResult = await tryOperation(
    ctx,
    async () => {
      await mkdir(tempDir, { recursive: true });
      const tarballPath = join(tempDir, `${packageName.replace(/[@/]/g, "-")}-${version}.tgz`);

      showProgress(ctx, "Downloading", `${packageName}@${version}`);

      const response = await fetchWithTimeout(tarballUrl, TIMEOUTS.packageInstall);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      await writeFile(tarballPath, new Uint8Array(buffer));

      return { tarballPath };
    },
    "Download failed"
  );

  if (!extractResult) {
    await cleanupStandaloneTempArtifacts(tempDir);
    logPackageInstall(
      pi,
      `npm:${packageName}`,
      packageName,
      version,
      scope,
      false,
      "Download failed"
    );
    void updateExtmgrStatus(ctx, pi);
    return;
  }
  const { tarballPath } = extractResult;

  // Extract
  const extractDir = join(
    tempDir,
    `extracted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  const extractSuccess = await tryOperation(
    ctx,
    async () => {
      await mkdir(extractDir, { recursive: true });
      notify(ctx, `Extracting ${packageName}...`, "info");

      const extractRes = await pi.exec(
        "tar",
        ["-xzf", tarballPath, "-C", extractDir, "--strip-components=1"],
        { timeout: TIMEOUTS.extractPackage, cwd: ctx.cwd }
      );

      await rm(tarballPath, { force: true });

      if (extractRes.code !== 0) {
        throw new Error(`Extraction failed: ${extractRes.stderr || extractRes.stdout}`);
      }

      const hasEntrypoint = await hasStandaloneEntrypoint(extractDir);
      if (!hasEntrypoint) {
        throw new Error(
          `Package ${packageName} does not contain a runnable standalone extension entrypoint (manifest-declared entrypoint, index.ts, or index.js)`
        );
      }

      const dependencyError = await getStandaloneDependencyError(extractDir);
      if (dependencyError) {
        throw new Error(dependencyError);
      }

      return true;
    },
    "Extraction failed"
  );

  if (!extractSuccess) {
    await cleanupStandaloneTempArtifacts(tempDir, extractDir);
    logPackageInstall(
      pi,
      `npm:${packageName}`,
      packageName,
      version,
      scope,
      false,
      "Extraction failed"
    );
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  // Copy to extensions dir
  const destResult = await tryOperation(
    ctx,
    async () => {
      const extDirName = packageName.replace(/[@/]/g, "-");
      const destDir = join(extensionDir, extDirName);

      await rm(destDir, { recursive: true, force: true });

      await cp(extractDir, destDir, { recursive: true });
      return destDir;
    },
    "Failed to copy extension"
  );

  await cleanupStandaloneTempArtifacts(tempDir, extractDir);

  if (!destResult) {
    logPackageInstall(
      pi,
      `npm:${packageName}`,
      packageName,
      version,
      scope,
      false,
      "Failed to copy extension"
    );
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  clearSearchCache();
  logPackageInstall(pi, `npm:${packageName}`, packageName, version, scope, true);
  success(ctx, `Installed ${packageName}@${version} locally to:\n${destResult}`);

  const reloaded = await confirmReload(ctx, "Extension installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
}
