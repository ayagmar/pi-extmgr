import type { ProgressEvent } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, Scope } from "../../src/types/index.js";
import {
  setPackageCatalogFactory,
  type AvailablePackageUpdate,
  type PackageCatalog,
} from "../../src/packages/catalog.js";
import { normalizePackageIdentity } from "../../src/utils/package-source.js";

export function mockPackageCatalog(options?: {
  packages?: InstalledPackage[];
  updates?: AvailablePackageUpdate[];
  installImpl?: (
    source: string,
    scope: Scope,
    onProgress?: (event: ProgressEvent) => void
  ) => Promise<void> | void;
  removeImpl?: (
    source: string,
    scope: Scope,
    onProgress?: (event: ProgressEvent) => void
  ) => Promise<void> | void;
  updateImpl?: (
    source: string | undefined,
    onProgress?: (event: ProgressEvent) => void
  ) => Promise<void> | void;
}): () => void {
  const packages = options?.packages ?? [];
  const updates = options?.updates ?? [];

  setPackageCatalogFactory(
    () =>
      ({
        listInstalledPackages(config) {
          if (config?.dedupe === false) {
            return Promise.resolve(packages.map((pkg) => ({ ...pkg })));
          }

          const deduped = new Map<string, InstalledPackage>();
          for (const pkg of packages) {
            const key = normalizePackageIdentity(
              pkg.source,
              pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : undefined
            );
            if (!deduped.has(key)) {
              deduped.set(key, { ...pkg });
            }
          }
          return Promise.resolve([...deduped.values()]);
        },
        checkForAvailableUpdates() {
          return Promise.resolve(updates.map((update) => ({ ...update })));
        },
        install(source, scope, onProgress) {
          return Promise.resolve(options?.installImpl?.(source, scope, onProgress));
        },
        remove(source, scope, onProgress) {
          return Promise.resolve(options?.removeImpl?.(source, scope, onProgress));
        },
        update(source, onProgress) {
          return Promise.resolve(options?.updateImpl?.(source, onProgress));
        },
      }) satisfies PackageCatalog
  );

  return () => setPackageCatalogFactory();
}
