/**
 * Package installation logic
 */
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { normalizePackageSource } from "../utils/format.js";
import { clearSearchCache } from "./discovery.js";
import { logPackageInstall } from "../utils/history.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { confirmAction, confirmReload, showProgress } from "../utils/ui-helpers.js";
import { tryOperation } from "../utils/mode.js";

export async function installPackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  // Check if it's a GitHub URL to a .ts file - handle as direct download
  const githubTsMatch = source.match(
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+\.ts)$/
  );
  if (githubTsMatch) {
    const [, owner, repo, branch, filePath] = githubTsMatch;
    if (!filePath) {
      notifyError(ctx, "Invalid GitHub URL format");
      return;
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const fileName = filePath.split("/").pop() || `${owner}-${repo}.ts`;
    await installFromUrl(rawUrl, fileName, ctx, pi);
    return;
  }

  // Check if it's already a raw URL to a .ts file
  if (source.match(/^https:\/\/raw\.githubusercontent\.com\/.*\.ts$/)) {
    const fileName = source.split("/").pop() || "extension.ts";
    await installFromUrl(source, fileName, ctx, pi);
    return;
  }

  const normalized = normalizePackageSource(source);

  // Confirm installation
  const confirmed = await confirmAction(ctx, "Install Package", `Install ${normalized}?`);
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  showProgress(ctx, "Installing", normalized);

  const res = await pi.exec("pi", ["install", normalized], { timeout: 180000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Install failed:\n${res.stderr || res.stdout || `exit ${res.code}`}`;
    logPackageInstall(pi, normalized, normalized, undefined, "global", false, errorMsg);
    notifyError(ctx, errorMsg);
    return;
  }

  clearSearchCache();
  logPackageInstall(pi, normalized, normalized, undefined, "global", true);
  success(ctx, `Installed ${normalized}`);

  await confirmReload(ctx, "Package installed.");
}

export async function installFromUrl(
  url: string,
  fileName: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<void> {
  const globalExtDir = join(homedir(), ".pi", "agent", "extensions");

  // Confirm installation
  const confirmed = await confirmAction(
    ctx,
    "Install from URL",
    `Download ${fileName} from GitHub?`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const result = await tryOperation(
    ctx,
    async () => {
      await mkdir(globalExtDir, { recursive: true });
      notify(ctx, `Downloading ${fileName}...`, "info");

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();
      const destPath = join(globalExtDir, fileName);
      await writeFile(destPath, content, "utf8");

      return { fileName, destPath };
    },
    "Installation failed"
  );

  if (!result) return;

  const { fileName: name, destPath } = result;
  success(ctx, `Installed ${name} to:\n${destPath}`);
  await confirmReload(ctx, "Extension installed.");
}

export async function installPackageLocally(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const globalExtDir = join(homedir(), ".pi", "agent", "extensions");

  // Confirm local installation
  const confirmed = await confirmAction(
    ctx,
    "Install Locally",
    `Download ${packageName} to ~/.pi/agent/extensions/?\n\nThis installs as a standalone extension (manual updates).`
  );
  if (!confirmed) {
    notify(ctx, "Installation cancelled.", "info");
    return;
  }

  const result = await tryOperation(
    ctx,
    async () => {
      await mkdir(globalExtDir, { recursive: true });
      showProgress(ctx, "Fetching", packageName);

      const viewRes = await pi.exec("npm", ["view", packageName, "--json"], {
        timeout: 30000,
        cwd: ctx.cwd,
      });

      if (viewRes.code !== 0) {
        throw new Error(`Failed to fetch package info: ${viewRes.stderr || viewRes.stdout}`);
      }

      const pkgInfo = JSON.parse(viewRes.stdout) as {
        version?: string;
        dist?: { tarball?: string };
      };
      const version = pkgInfo.version ?? "latest";
      const tarballUrl = pkgInfo.dist?.tarball;

      if (!tarballUrl) {
        throw new Error("No tarball URL found for package");
      }

      return { version, tarballUrl };
    },
    "Failed to fetch package info"
  );

  if (!result) return;
  const { version, tarballUrl } = result;

  // Download and extract
  const extractResult = await tryOperation(
    ctx,
    async () => {
      const tempDir = join(globalExtDir, ".temp");
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

  if (!extractResult) return;
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
        { timeout: 30000, cwd: ctx.cwd }
      );

      await rm(tarballPath, { force: true });

      if (extractRes.code !== 0) {
        throw new Error(`Extraction failed: ${extractRes.stderr || extractRes.stdout}`);
      }

      // Verify index.ts exists
      const indexPath = join(extractDir, "index.ts");
      try {
        await access(indexPath);
      } catch {
        throw new Error(`Package ${packageName} does not have an index.ts file`);
      }

      return true;
    },
    "Extraction failed"
  );

  if (!extractSuccess) {
    await rm(extractDir, { recursive: true, force: true });
    return;
  }

  // Copy to extensions dir
  const destResult = await tryOperation(
    ctx,
    async () => {
      const extDirName = packageName.replace(/[@/]/g, "-");
      const destDir = join(globalExtDir, extDirName);

      await rm(destDir, { recursive: true, force: true });

      const copyRes = await pi.exec("cp", ["-r", extractDir, destDir], {
        timeout: 30000,
        cwd: ctx.cwd,
      });

      if (copyRes.code !== 0) {
        throw new Error(
          `Failed to copy extension directory: ${copyRes.stderr || copyRes.stdout || `exit ${copyRes.code}`}`
        );
      }

      return destDir;
    },
    "Failed to copy extension"
  );

  await rm(extractDir, { recursive: true, force: true });

  if (!destResult) return;

  clearSearchCache();
  success(ctx, `Installed ${packageName}@${version} locally to:\n${destResult}/index.ts`);
  await confirmReload(ctx, "Extension installed.");
}
