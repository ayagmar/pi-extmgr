/**
 * Package installation logic
 */
import { mkdir, rm, writeFile, cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { normalizePackageSource } from "../utils/format.js";
import { fileExists } from "../utils/fs.js";
import { clearSearchCache, isSourceInstalled } from "./discovery.js";
import { waitForCondition } from "../utils/retry.js";
import { logPackageInstall } from "../utils/history.js";
import { clearUpdatesAvailable } from "../utils/settings.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { confirmAction, confirmReload, showProgress } from "../utils/ui-helpers.js";
import { tryOperation } from "../utils/mode.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { TIMEOUTS } from "../constants.js";

export type InstallScope = "global" | "project";

export interface InstallOptions {
  scope?: InstallScope;
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

/**
 * Safely extracts regex match groups with validation
 */
function safeExtractGithubMatch(
  match: RegExpMatchArray | null
): { owner: string; repo: string; branch: string; filePath: string } | undefined {
  if (!match) return undefined;

  const owner = match[1];
  const repo = match[2];
  const branch = match[3];
  const filePath = match[4];

  if (!owner || !repo || !branch || !filePath) {
    return undefined;
  }

  return { owner, repo, branch, filePath };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

async function hasStandaloneEntrypoint(packageRoot: string): Promise<boolean> {
  try {
    const manifestPath = join(packageRoot, "package.json");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
    const declared = parsed.pi?.extensions;

    if (Array.isArray(declared) && declared.length > 0) {
      for (const entry of declared) {
        if (typeof entry !== "string" || !entry.trim()) continue;
        const candidate = join(packageRoot, normalizeRelativePath(entry));
        if (await fileExists(candidate)) {
          return true;
        }
      }
      return false;
    }
  } catch {
    // Ignore invalid/missing manifest and fall back to conventional entrypoints.
  }

  return (
    (await fileExists(join(packageRoot, "index.ts"))) ||
    (await fileExists(join(packageRoot, "index.js")))
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
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+\.ts)$/
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

  const args = ["install", ...(scope === "project" ? ["-l"] : []), normalized];
  const res = await pi.exec("pi", args, { timeout: TIMEOUTS.packageInstall, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Install failed:\n${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageInstall(pi, normalized, normalized, undefined, scope, false, errorMsg);
    notifyError(ctx, errorMsg);
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  clearSearchCache();
  logPackageInstall(pi, normalized, normalized, undefined, scope, true);
  success(ctx, `Installed ${normalized} (${scope})`);
  clearUpdatesAvailable(pi, ctx);

  // Wait for the extension to be discoverable before reloading.
  // This prevents a race condition where ctx.reload() runs before
  // settings.json or extension files are fully flushed to disk.
  notify(ctx, "Waiting for extension to be ready...", "info");
  const isReady = await waitForCondition(() => isSourceInstalled(normalized, ctx, pi, { scope }), {
    maxAttempts: 10,
    delayMs: 100,
    backoff: "exponential",
  });

  if (!isReady) {
    notify(
      ctx,
      "Extension may not be immediately available. Reload pi manually if needed.",
      "warning"
    );
  }

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

      const response = await fetch(url);
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
  clearUpdatesAvailable(pi, ctx);

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

      const viewRes = await pi.exec("npm", ["view", packageName, "--json"], {
        timeout: TIMEOUTS.fetchPackageInfo,
        cwd: ctx.cwd,
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

  // Download and extract
  const extractResult = await tryOperation(
    ctx,
    async () => {
      const tempDir = join(extensionDir, ".temp");
      await mkdir(tempDir, { recursive: true });
      const tarballPath = join(tempDir, `${packageName.replace(/[@/]/g, "-")}-${version}.tgz`);

      showProgress(ctx, "Downloading", `${packageName}@${version}`);

      const response = await fetch(tarballUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      await writeFile(tarballPath, new Uint8Array(buffer));

      return { tarballPath, tempDir };
    },
    "Download failed"
  );

  if (!extractResult) {
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
  const { tarballPath, tempDir } = extractResult;

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
          `Package ${packageName} does not contain a runnable extension entrypoint (pi.extensions, index.ts, or index.js)`
        );
      }

      return true;
    },
    "Extraction failed"
  );

  if (!extractSuccess) {
    await rm(extractDir, { recursive: true, force: true });
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

  await rm(extractDir, { recursive: true, force: true });

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
  clearUpdatesAvailable(pi, ctx);

  const reloaded = await confirmReload(ctx, "Extension installed.");
  if (!reloaded) {
    void updateExtmgrStatus(ctx, pi);
  }
}
