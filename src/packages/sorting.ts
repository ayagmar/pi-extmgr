import { type NpmPackage } from "../types/index.js";

export type RemotePackageSort = "relevance" | "downloads" | "popular" | "recent" | "name";

export function sortRemotePackages(packages: NpmPackage[], sort: RemotePackageSort): NpmPackage[] {
  if (sort === "relevance") return [...packages];
  return [...packages].sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    if (sort === "downloads" || sort === "popular") {
      // Stable sort preserves registry relevance until downloads hydrate, and
      // preserves relevance for equal download counts afterward.
      return (right.weeklyDownloads ?? -1) - (left.weeklyDownloads ?? -1);
    }
    return (right.date ?? "").localeCompare(left.date ?? "") || left.name.localeCompare(right.name);
  });
}
