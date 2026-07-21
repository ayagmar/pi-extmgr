/** Pure formatting helpers for Discover browse rows and detail panes. */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { type NpmPackage } from "../../types/index.js";
import { formatCompactCount } from "../layout.js";
import { formatCount } from "./metadata.js";

export function formatRemotePackageLabel(pkg: NpmPackage, theme: Theme): string {
  const name = theme.bold(pkg.name);
  const version = pkg.version ? theme.fg("dim", `@${pkg.version}`) : "";
  const downloads = formatCompactCount(pkg.weeklyDownloads);
  const badges = [
    pkg.installed ? theme.fg("success", "installed") : undefined,
    pkg.updateAvailable ? theme.fg("warning", "update") : undefined,
  ].filter(Boolean);
  const popularity = downloads ? theme.fg("muted", ` · ${downloads}/wk`) : "";
  return `${name}${version}${popularity}${badges.length ? ` [${badges.join(" · ")}]` : ""}`;
}

export function formatRemotePackageDetails(
  pkg: NpmPackage,
  selectedNumber: number,
  totalResults: number
): string {
  const parts = [
    pkg.description || "No description",
    pkg.author ? `by ${pkg.author}` : undefined,
    pkg.weeklyDownloads !== undefined
      ? `${formatCount(pkg.weeklyDownloads)} downloads/week`
      : undefined,
    `result ${selectedNumber} of ${totalResults}`,
    pkg.keywords?.length ? `keywords: ${pkg.keywords.slice(0, 5).join(", ")}` : undefined,
    pkg.date ? `updated ${pkg.date.slice(0, 10)}` : undefined,
  ];

  return parts.filter(Boolean).join(" • ");
}
