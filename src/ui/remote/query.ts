import { type NpmPackage } from "../../types/index.js";
import { normalizePackageSource, parseNpmSource, truncate } from "../../utils/format.js";
import { getPackageSourceKind } from "../../utils/package-source.js";

export const COMMUNITY_BROWSE_QUERY = "keywords:pi-package";
export type RemoteBrowseSource = "community" | "npm";
export type RemoteBrowseQueryPlan =
  | {
      kind: "browse";
      rawQuery: typeof COMMUNITY_BROWSE_QUERY;
      searchQuery: typeof COMMUNITY_BROWSE_QUERY;
      displayQuery: "";
      title: "Community packages";
    }
  | {
      kind: "search";
      rawQuery: string;
      searchQuery: string;
      displayQuery: string;
      title: string;
      exactPackageName?: string;
    }
  | { kind: "unsupported"; rawQuery: string; message: string };

function findExactPackageLookup(query: string): string | undefined {
  if (!query || /\s/.test(query)) return undefined;
  const parsed = parseNpmSource(normalizePackageSource(query));
  if (!parsed?.name) return undefined;
  if (query.startsWith("npm:") || Boolean(parsed.version) || parsed.name.startsWith("@")) {
    return parsed.name.toLowerCase();
  }
  return undefined;
}

export function createRemoteBrowseQueryPlan(query: string): RemoteBrowseQueryPlan {
  const trimmed = query.trim();
  if (!trimmed || trimmed === COMMUNITY_BROWSE_QUERY) {
    return {
      kind: "browse",
      rawQuery: COMMUNITY_BROWSE_QUERY,
      searchQuery: COMMUNITY_BROWSE_QUERY,
      displayQuery: "",
      title: "Community packages",
    };
  }
  const sourceKind = getPackageSourceKind(trimmed);
  if (sourceKind === "local" || sourceKind === "git") {
    return {
      kind: "unsupported",
      rawQuery: trimmed,
      message: `"${truncate(trimmed, 60)}" looks like a ${sourceKind === "local" ? "local path" : "git source"}. Remote browse searches npm package names and keywords. Use Install by source instead.`,
    };
  }
  const exactPackageName = findExactPackageLookup(trimmed);
  return {
    kind: "search",
    rawQuery: trimmed,
    searchQuery: exactPackageName ?? trimmed,
    displayQuery: trimmed,
    title: "Remote packages",
    ...(exactPackageName ? { exactPackageName } : {}),
  };
}

export function createCommunityBrowsePlan(
  query: string
): Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }> {
  const trimmed = query.trim();
  if (!trimmed || trimmed === COMMUNITY_BROWSE_QUERY) {
    return {
      kind: "browse",
      rawQuery: COMMUNITY_BROWSE_QUERY,
      searchQuery: COMMUNITY_BROWSE_QUERY,
      displayQuery: "",
      title: "Community packages",
    };
  }
  return {
    kind: "search",
    rawQuery: trimmed,
    searchQuery: `${COMMUNITY_BROWSE_QUERY} ${trimmed}`,
    displayQuery: trimmed,
    title: "Community packages",
  };
}

export function resolveRemoteBrowseSource(
  query: string,
  source?: RemoteBrowseSource
): RemoteBrowseSource {
  if (source) return source;
  const trimmed = query.trim();
  return !trimmed || trimmed === COMMUNITY_BROWSE_QUERY ? "community" : "npm";
}

export function filterRemoteBrowseResults(
  plan: Exclude<RemoteBrowseQueryPlan, { kind: "unsupported" }>,
  packages: NpmPackage[]
): NpmPackage[] {
  if (plan.kind !== "search" || !plan.exactPackageName) return packages;
  return packages.filter((pkg) => pkg.name.toLowerCase() === plan.exactPackageName);
}
