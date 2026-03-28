import {
  DefaultPackageManager,
  getAgentDir,
  type PackageSource,
  type ProgressEvent,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type InstalledPackage, type Scope } from "../types/index.js";
import { normalizePackageIdentity, parsePackageNameAndVersion } from "../utils/package-source.js";

type PiScope = "user" | "project";
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

type PackageCatalogFactory = (cwd: string) => PackageCatalog;

let packageCatalogFactory: PackageCatalogFactory = createDefaultPackageCatalog;

function toScope(scope: PiScope): Scope {
  return scope === "project" ? "project" : "global";
}

function getPackageSource(pkg: PackageSource): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function createPackageRecord(
  source: string,
  scope: PiScope,
  packageManager: DefaultPackageManager
): InstalledPackage {
  const resolvedPath = packageManager.getInstalledPath(source, scope);
  const { name, version } = parsePackageNameAndVersion(source);

  return {
    source,
    name,
    scope: toScope(scope),
    ...(version ? { version } : {}),
    ...(resolvedPath ? { resolvedPath } : {}),
  };
}

function dedupeInstalledPackages(packages: InstalledPackage[], cwd: string): InstalledPackage[] {
  const byIdentity = new Map<string, InstalledPackage>();

  for (const pkg of packages) {
    const baseCwd = pkg.scope === "project" ? cwd : getAgentDir();
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

function createDefaultPackageCatalog(cwd: string): PackageCatalog {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

  return {
    listInstalledPackages(options) {
      const projectPackages = (settingsManager.getProjectSettings().packages ?? []).map((pkg) =>
        createPackageRecord(getPackageSource(pkg), "project", packageManager)
      );
      const globalPackages = (settingsManager.getGlobalSettings().packages ?? []).map((pkg) =>
        createPackageRecord(getPackageSource(pkg), "user", packageManager)
      );

      const installed = [...projectPackages, ...globalPackages];
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
        await packageManager.install(source, { local: scope === "project" });
        packageManager.addSourceToSettings(source, { local: scope === "project" });
        await settingsManager.flush();
      } finally {
        setProgressCallback(packageManager, undefined);
      }
    },

    async remove(source, scope, onProgress) {
      setProgressCallback(packageManager, onProgress);

      try {
        await packageManager.remove(source, { local: scope === "project" });
        const removed = packageManager.removeSourceFromSettings(source, {
          local: scope === "project",
        });
        await settingsManager.flush();

        if (!removed) {
          throw new Error(`No matching package found for ${source}`);
        }
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

export function getPackageCatalog(cwd: string): PackageCatalog {
  return packageCatalogFactory(cwd);
}

export function setPackageCatalogFactory(factory?: PackageCatalogFactory): void {
  packageCatalogFactory = factory ?? createDefaultPackageCatalog;
}
