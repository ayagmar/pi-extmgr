import { type NpmPackage } from "../types/index.js";

export type RemotePackageSort = "relevance" | "name" | "recent";

export function sortRemotePackages(packages: NpmPackage[], sort: RemotePackageSort): NpmPackage[] {
  if (sort === "relevance") return [...packages];
  return [...packages].sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    return (right.date ?? "").localeCompare(left.date ?? "") || left.name.localeCompare(right.name);
  });
}
