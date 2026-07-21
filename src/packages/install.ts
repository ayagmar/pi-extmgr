/**
 * Package installation logic
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TIMEOUTS } from "../constants.js";
import { getAgentDir, getExtmgrTrashDir, getProjectExtensionsDir } from "../utils/pi-paths.js";
import { runTaskWithLoader } from "../ui/async-task.js";
import { parseChoiceByLabel } from "../utils/command.js";
import { normalizePackageSource } from "../utils/format.js";
import { fileExists } from "../utils/fs.js";
import { logPackageInstall } from "../utils/history.js";
import { isProjectTrusted, tryOperation } from "../utils/mode.js";
import {
  downloadToFile,
  MAX_COMPRESSED_DOWNLOAD_BYTES,
  MAX_DIRECT_EXTENSION_BYTES,
} from "../utils/network.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { getProgressMessage } from "../utils/progress.js";
import { execNpm } from "../utils/npm-exec.js";
import { normalizePackageIdentity } from "../utils/package-source.js";
import { clearUpdatesAvailable } from "../utils/settings.js";
import { moveToExtensionTrash, undoExtensionTrash, type TrashRecord } from "../extensions/trash.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmAction, confirmReload, showProgress } from "../utils/ui-helpers.js";
import { getPackageCatalog } from "./catalog.js";
import { clearSearchCache } from "./discovery.js";
import {
  clearPackageEntrypointCache,
  discoverPackageExtensionEntrypoints,
  readPackageManifest,
} from "./extensions.js";

export type InstallScope = "global" | "project";

export interface InstallOptions {
  scope?: InstallScope;
  skipConfirmation?: boolean;
}

export interface InstallOutcome {
  installed: boolean;
  reloaded: boolean;
}

const INSTALL_SCOPE_CHOICES = {
  global: "Global (~/.pi/agent/settings.json)",
  project: ".pi/settings.json",
  cancel: "Cancel",
} as const;

async function resolveInstallScope(
  ctx: ExtensionCommandContext,
  explicitScope?: InstallScope
): Promise<InstallScope | undefined> {
  if (explicitScope) return explicitScope;

  if (!ctx.hasUI) return "global";

  const choice = parseChoiceByLabel(
    INSTALL_SCOPE_CHOICES,
    await ctx.ui.select("Install scope", Object.values(INSTALL_SCOPE_CHOICES))
  );

  return choice === "cancel" ? undefined : choice;
}

function getExtensionInstallDir(ctx: ExtensionCommandContext, scope: InstallScope): string {
  if (scope === "project") {
    return getProjectExtensionsDir(ctx.cwd);
  }
  return join(getAgentDir(), "extensions");
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

async function installPackageInternal(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<InstallOutcome> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
  }

  // Check if it's a GitHub URL to a .ts file - handle as direct download
  const githubTsMatch = source.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.ts)$/
  );
  if (githubTsMatch) {
    const [, owner, repo, branch, filePath] = githubTsMatch;
    if (owner && repo && branch && filePath) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      const fileName = filePath.split("/").pop() || `${owner}-${repo}.ts`;
      return await installFromUrl(rawUrl, fileName, ctx, pi, { scope });
    }
  }

  // Check if it's already a raw URL to a .ts file
  if (source.match(/^https:\/\/raw\.githubusercontent\.com\/.*\.ts$/)) {
    const fileName = source.split("/").pop() || "extension.ts";
    return await installFromUrl(source, fileName, ctx, pi, { scope });
  }

  const normalized = normalizePackageSource(source);

  // Confirm installation
  const confirmed = options?.skipConfirmation
    ? true
    : await confirmAction(ctx, "Install Package", `Install ${normalized} (${scope})?`);
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
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
        await getPackageCatalog(ctx.cwd, isProjectTrusted(ctx)).install(
          normalized,
          scope,
          (event) => {
            setMessage(getProgressMessage(event, `Installing ${normalized}...`));
          }
        );
        return undefined;
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorMsg = `Install failed:\n${message}`;
    logPackageInstall(pi, normalized, normalized, undefined, scope, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return { installed: false, reloaded: false };
  }

  clearSearchCache();
  clearPackageEntrypointCache();
  logPackageInstall(pi, normalized, normalized, undefined, scope, true);
  success(ctx, `Installed ${normalized} (${scope})`);
  clearUpdatesAvailable(pi, ctx, [normalizePackageIdentity(normalized, { cwd: ctx.cwd })]);

  const reloaded = await confirmReload(ctx, "Package installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }

  return { installed: true, reloaded };
}

export async function installPackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<void> {
  await installPackageInternal(source, ctx, pi, options);
}

export async function installPackageWithOutcome(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<InstallOutcome> {
  return installPackageInternal(source, ctx, pi, options);
}

export async function installFromUrl(
  url: string,
  fileName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<InstallOutcome> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
  }

  const extensionDir = getExtensionInstallDir(ctx, scope);
  const safeFileName = basename(fileName);
  if (!safeFileName.endsWith(".ts") || safeFileName !== fileName) {
    notifyError(
      ctx,
      "Installation failed: direct extension destination must be a plain .ts filename."
    );
    return { installed: false, reloaded: false };
  }

  const confirmed = await confirmAction(
    ctx,
    "Install from URL",
    `Download ${safeFileName} to ${scope} extensions?`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
  }

  const result = await tryOperation(
    ctx,
    async () => {
      await mkdir(extensionDir, { recursive: true });
      const destPath = join(extensionDir, safeFileName);
      const exists = await fileExists(destPath);
      if (exists) {
        if (!ctx.hasUI)
          throw new Error(
            `Destination already exists: ${destPath}. Interactive replacement confirmation is required.`
          );
        const replace = await confirmAction(
          ctx,
          "Replace extension",
          `${destPath} already exists. Move it to extmgr trash and replace it?`
        );
        if (!replace) throw new Error("Replacement cancelled; existing extension was preserved.");
      }

      const temporary = join(
        extensionDir,
        `.${safeFileName}.${process.pid}.${Date.now()}.download.tmp`
      );
      let trashed: TrashRecord | undefined;
      try {
        notify(ctx, `Downloading ${safeFileName}...`, "info");
        await downloadToFile(
          url,
          temporary,
          TIMEOUTS.packageInstall,
          MAX_DIRECT_EXTENSION_BYTES,
          ctx.signal
        );
        if (exists) trashed = await moveToExtensionTrash(destPath, getExtmgrTrashDir());
        try {
          await rename(temporary, destPath);
        } catch (error) {
          if (trashed) await undoExtensionTrash(trashed);
          throw error;
        }
        return { fileName: safeFileName, destPath };
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    "Installation failed"
  );

  if (!result) {
    logPackageInstall(pi, url, fileName, undefined, scope, false, "Installation failed");
    void updateExtmgrStatus(ctx, pi);
    return { installed: false, reloaded: false };
  }

  const { fileName: name, destPath } = result;
  logPackageInstall(pi, url, name, undefined, scope, true);
  success(ctx, `Installed ${name} to:\n${destPath}`);

  const reloaded = await confirmReload(ctx, "Extension installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }

  return { installed: true, reloaded };
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

async function installPackageLocallyInternal(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<InstallOutcome> {
  const scope = await resolveInstallScope(ctx, options?.scope);
  if (!scope) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
  }

  const extensionDir = getExtensionInstallDir(ctx, scope);

  // Confirm local installation
  const confirmed = options?.skipConfirmation
    ? true
    : await confirmAction(
        ctx,
        "Install Locally",
        `Download ${packageName} to ${scope} extensions?\n\nThis installs as a standalone extension (manual updates).`
      );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return { installed: false, reloaded: false };
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
    return { installed: false, reloaded: false };
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
    return { installed: false, reloaded: false };
  }

  // Download and extract into an install-specific temporary sibling.
  const tempDir = join(
    extensionDir,
    `.extmgr-install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const extractResult = await tryOperation(
    ctx,
    async () => {
      await mkdir(tempDir, { recursive: true });
      const tarballPath = join(tempDir, `${packageName.replace(/[@/]/g, "-")}-${version}.tgz`);

      showProgress(ctx, "Downloading", `${packageName}@${version}`);

      await downloadToFile(
        tarballUrl,
        tarballPath,
        TIMEOUTS.packageInstall,
        MAX_COMPRESSED_DOWNLOAD_BYTES,
        ctx.signal
      );

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
    return { installed: false, reloaded: false };
  }
  const { tarballPath } = extractResult;

  // Extract
  const extractDir = join(tempDir, "ready");

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
    return { installed: false, reloaded: false };
  }

  // Atomically swap only after the complete temporary package validates.
  const destResult = await tryOperation(
    ctx,
    async () => {
      const extDirName = packageName.replace(/[@/]/g, "-");
      const destDir = join(extensionDir, extDirName);
      const exists = await fileExists(destDir);
      if (exists) {
        if (!ctx.hasUI && options?.skipConfirmation !== true) {
          throw new Error(
            `Destination already exists: ${destDir}. Explicit replacement confirmation is required.`
          );
        }
        if (
          ctx.hasUI &&
          !(await confirmAction(
            ctx,
            "Replace standalone extension",
            `${destDir} already exists. Replace it after validation?`
          ))
        ) {
          throw new Error("Replacement cancelled; existing extension was preserved.");
        }
      }
      let trashed: TrashRecord | undefined;
      try {
        if (exists) trashed = await moveToExtensionTrash(destDir, getExtmgrTrashDir());
        await rename(extractDir, destDir);
      } catch (error) {
        await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
        if (trashed) await undoExtensionTrash(trashed);
        throw error;
      }
      return { destDir, replaced: Boolean(trashed) };
    },
    "Failed to swap extension"
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
    return { installed: false, reloaded: false };
  }

  clearSearchCache();
  clearPackageEntrypointCache();
  logPackageInstall(pi, `npm:${packageName}`, packageName, version, scope, true);
  success(
    ctx,
    `Installed ${packageName}@${version} locally to:\n${destResult.destDir}${destResult.replaced ? "\nThe previous installation is available in extmgr trash." : ""}`
  );

  const reloaded = await confirmReload(ctx, "Extension installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }

  return { installed: true, reloaded };
}

export async function installPackageLocally(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<void> {
  await installPackageLocallyInternal(packageName, ctx, pi, options);
}

export async function installPackageLocallyWithOutcome(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: InstallOptions
): Promise<InstallOutcome> {
  return installPackageLocallyInternal(packageName, ctx, pi, options);
}
