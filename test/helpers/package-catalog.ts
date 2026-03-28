import { type ProgressEvent } from "@mariozechner/pi-coding-agent";
import {
  type AvailablePackageUpdate,
  type PackageCatalog,
  setPackageCatalogFactory,
} from "../../src/packages/catalog.js";
import { type InstalledPackage, type Scope } from "../../src/types/index.js";
import {
  normalizePackageIdentity,
  parsePackageNameAndVersion,
} from "../../src/utils/package-source.js";

export function mockPackageCatalog(options?: {
  packages?: InstalledPackage[];
  updates?: AvailablePackageUpdate[];
  checkForAvailableUpdatesImpl?: () => Promise<AvailablePackageUpdate[]> | AvailablePackageUpdate[];
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
  let packages = [...(options?.packages ?? [])];
  let updates = [...(options?.updates ?? [])];

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
        async checkForAvailableUpdates() {
          const result = await options?.checkForAvailableUpdatesImpl?.();
          const nextUpdates = result ?? updates;
          return nextUpdates.map((update) => ({ ...update }));
        },
        async install(source, scope, onProgress) {
          await options?.installImpl?.(source, scope, onProgress);

          const identity = normalizePackageIdentity(source);
          packages = packages.filter(
            (pkg) => !(pkg.scope === scope && normalizePackageIdentity(pkg.source) === identity)
          );

          const parsed = parsePackageNameAndVersion(source);
          packages.push({
            source,
            name: parsed.name,
            ...(parsed.version ? { version: parsed.version } : {}),
            scope,
          });
        },
        async remove(source, scope, onProgress) {
          await options?.removeImpl?.(source, scope, onProgress);

          const identity = normalizePackageIdentity(source);
          packages = packages.filter(
            (pkg) => !(pkg.scope === scope && normalizePackageIdentity(pkg.source) === identity)
          );
          updates = updates.filter(
            (update) =>
              !(update.scope === scope && normalizePackageIdentity(update.source) === identity)
          );
        },
        async update(source, onProgress) {
          await options?.updateImpl?.(source, onProgress);

          if (!source) {
            updates = [];
            return;
          }

          const identity = normalizePackageIdentity(source);
          const matchingUpdate = updates.find(
            (update) => normalizePackageIdentity(update.source) === identity
          );

          if (matchingUpdate) {
            const parsed = parsePackageNameAndVersion(matchingUpdate.source);
            packages = packages.map((pkg) => {
              if (normalizePackageIdentity(pkg.source) !== identity) {
                return pkg;
              }

              return {
                ...pkg,
                source: matchingUpdate.source,
                name: matchingUpdate.displayName || parsed.name,
                ...(parsed.version ? { version: parsed.version } : {}),
              };
            });
          }

          updates = updates.filter(
            (update) => normalizePackageIdentity(update.source) !== identity
          );
        },
      }) satisfies PackageCatalog
  );

  return () => setPackageCatalogFactory();
}
