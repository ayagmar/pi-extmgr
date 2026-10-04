import {
  DefaultPackageManager,
  getAgentDir,
  type ProgressEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type InstalledPackage, type Scope } from "../types/index.js";
import { normalizePackageIdentity, parsePackageNameAndVersion } from "../utils/package-source.js";
import { getProjectConfigDir } from "../utils/pi-paths.js";
import { throwIfSettingsErrors } from "../utils/settings-errors.js";

type PiScope = "user" | "project";
type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];
type PiPackageUpdate = Awaited<
  ReturnType<DefaultPackageManager["checkForAvailableUpdates"]>
>[number];

export interface AvailablePackageUpdate {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: Scope;
}

export interface PackageCatalog {
  listInstalledPackages(options?: { dedupe?: boolean }): Promise<InstalledPackage[]>;
  checkForAvailableUpdates(): Promise<AvailablePackageUpdate[]>;
  install(source: string, scope: Scope, onProgress?: (event: ProgressEvent) => void): Promise<void>;
  remove(source: string, scope: Scope, onProgress?: (event: ProgressEvent) => void): Promise<void>;
  update(source?: string, onProgress?: (event: ProgressEvent) => void): Promise<void>;
}

export interface PackageCatalogOptions {
  /** Keep package-manager subprocess output out of Pi's interactive TUI. */
  suppressOutput?: boolean;
}

type PackageCatalogFactory = (
  cwd: string,
  projectTrusted?: boolean,
  options?: PackageCatalogOptions
) => PackageCatalog;

let packageCatalogFactory: PackageCatalogFactory = createDefaultPackageCatalog;

function toScope(scope: PiScope): Scope {
  return scope === "project" ? "project" : "global";
}

function createPackageRecord({
  source,
  scope,
  installedPath,
}: ConfiguredPackage): InstalledPackage {
  const { name, version } = parsePackageNameAndVersion(source);

  return {
    source,
    name,
    scope: toScope(scope),
    ...(version ? { version } : {}),
    ...(installedPath ? { resolvedPath: installedPath } : {}),
  };
}

function dedupeInstalledPackages(packages: InstalledPackage[], cwd: string): InstalledPackage[] {
  const byIdentity = new Map<string, InstalledPackage>();

  for (const pkg of packages) {
    const baseCwd = pkg.scope === "project" ? getProjectConfigDir(cwd) : getAgentDir();
    const identity = normalizePackageIdentity(pkg.source, {
      ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
      cwd: baseCwd,
    });

    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, pkg);
    }
  }

  return [...byIdentity.values()];
}

function setProgressCallback(
  packageManager: DefaultPackageManager,
  onProgress?: (event: ProgressEvent) => void
): void {
  packageManager.setProgressCallback(onProgress);
}

interface PackageManagerChild {
  stdout?: { resume?: () => void };
  stderr?: { resume?: () => void };
}

interface PackageManagerRuntime {
  spawnCommand?: (...args: unknown[]) => PackageManagerChild;
  spawnCaptureCommand?: (...args: unknown[]) => PackageManagerChild;
  runCommand?: (...args: unknown[]) => Promise<void>;
  runCommandCapture?: (...args: unknown[]) => Promise<string>;
}

/** npm and git can print pages of output; keep the end, where the reason is. */
const MAX_COMMAND_ERROR_CHARS = 4000;

function trimCommandError(error: unknown): unknown {
  if (!(error instanceof Error) || error.message.length <= MAX_COMMAND_ERROR_CHARS) return error;
  const trimmed = new Error(`…${error.message.slice(-MAX_COMMAND_ERROR_CHARS)}`);
  if (error.stack) trimmed.stack = error.stack;
  return trimmed;
}

/**
 * Adapt Pi's inherited-output command runner for an extmgr-owned TUI.
 *
 * Pi does not expose a public output-mode option yet, so this deliberately
 * small compatibility boundary is kept isolated and fails loudly if the
 * private runtime shape changes.
 *
 * pi's runCommand inherits the child's output and rejects with only the exit
 * code, so it is routed through runCommandCapture, which collects stdout and
 * stderr and puts them in the error: a failed install still says why. Any
 * other direct spawnCommand caller gets a captured child whose streams are
 * resumed immediately; it still owns the exit/error listeners and semantics.
 */
export function suppressPackageManagerOutput(packageManager: unknown): void {
  const internal = packageManager as PackageManagerRuntime;
  if (typeof internal.spawnCommand !== "function") {
    throw new Error("Pi package manager cannot suppress output: spawnCommand is unavailable");
  }
  if (typeof internal.spawnCaptureCommand !== "function") {
    throw new Error(
      "Pi package manager cannot suppress output: spawnCaptureCommand is unavailable"
    );
  }
  if (typeof internal.runCommand !== "function") {
    throw new Error("Pi package manager cannot suppress output: runCommand is unavailable");
  }
  if (typeof internal.runCommandCapture !== "function") {
    throw new Error("Pi package manager cannot suppress output: runCommandCapture is unavailable");
  }

  const runCapture = internal.runCommandCapture.bind(packageManager);
  internal.runCommand = (...args) =>
    runCapture(...args).then(
      () => undefined,
      (error: unknown) => Promise.reject(trimCommandError(error))
    );

  const capture = internal.spawnCaptureCommand.bind(packageManager);
  internal.spawnCommand = (...args) => {
    const child = capture(...args);
    if (!child || typeof child !== "object") {
      throw new Error("Pi package manager cannot suppress output: invalid child process");
    }
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    return child;
  };
}

function createDefaultPackageCatalog(
  cwd: string,
  projectTrusted = false,
  options: PackageCatalogOptions = {}
): PackageCatalog {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  if (options.suppressOutput) suppressPackageManagerOutput(packageManager);

  return {
    listInstalledPackages(options) {
      // pi lists global entries first; project entries go first here so that
      // dedupe keeps the project copy, the one pi actually loads.
      const configured = packageManager.listConfiguredPackages();
      const installed = [
        ...configured.filter((pkg) => pkg.scope === "project"),
        ...configured.filter((pkg) => pkg.scope === "user"),
      ].map(createPackageRecord);
      return Promise.resolve(
        options?.dedupe === false ? installed : dedupeInstalledPackages(installed, cwd)
      );
    },

    async checkForAvailableUpdates() {
      const updates = await packageManager.checkForAvailableUpdates();
      return updates.map((update: PiPackageUpdate) => ({
        source: update.source,
        displayName: update.displayName,
        type: update.type,
        scope: toScope(update.scope),
      }));
    },

    async install(source, scope, onProgress) {
      setProgressCallback(packageManager, onProgress);

      try {
        throwIfSettingsErrors(settingsManager, "Package installation");
        await packageManager.installAndPersist(source, { local: scope === "project" });
        await settingsManager.flush();
        throwIfSettingsErrors(settingsManager, "Package installation");
      } finally {
        setProgressCallback(packageManager, undefined);
      }
    },

    async remove(source, scope, onProgress) {
      setProgressCallback(packageManager, onProgress);

      try {
        throwIfSettingsErrors(settingsManager, "Package removal");
        // Settings may already have been persisted by a reviewed profile
        // application. The package manager removal remains authoritative; a
        // missing settings entry (removeAndPersist resolving false) is not a
        // reason to report a false mutation failure or undo a completed
        // physical removal.
        await packageManager.removeAndPersist(source, { local: scope === "project" });
        await settingsManager.flush();
        throwIfSettingsErrors(settingsManager, "Package removal");
      } finally {
        setProgressCallback(packageManager, undefined);
      }
    },

    async update(source, onProgress) {
      setProgressCallback(packageManager, onProgress);

      try {
        await packageManager.update(source);
      } finally {
        setProgressCallback(packageManager, undefined);
      }
    },
  };
}

export function getPackageCatalog(
  cwd: string,
  projectTrusted = false,
  options?: PackageCatalogOptions
): PackageCatalog {
  return packageCatalogFactory(cwd, projectTrusted, options);
}

export function setPackageCatalogFactory(factory?: PackageCatalogFactory): void {
  packageCatalogFactory = factory ?? createDefaultPackageCatalog;
}
