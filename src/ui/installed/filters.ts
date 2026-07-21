/** Filtering and search scoring for Installed workspace items. */
import { fuzzyMatch } from "@earendil-works/pi-tui";
import { type State, type UnifiedItem } from "../../types/index.js";
import { getPackageSourceKind } from "../../utils/package-source.js";
import { compactDisplayPath, formatPackageExtensionState } from "./formatting.js";
import { getCurrentUnifiedItemState, getLocalItemCurrentPath } from "./items.js";
import { type UnifiedFilter } from "./state.js";

export function matchesUnifiedFilter(
  item: UnifiedItem,
  filter: UnifiedFilter,
  staged: Map<string, State>,
  favoriteIds: ReadonlySet<string>,
  recentIds: ReadonlySet<string>
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "local":
      return item.type === "local";
    case "packages":
      return item.type === "package";
    case "updates":
      return item.type === "package" && Boolean(item.updateAvailable);
    case "disabled":
      if (item.type === "local") {
        return getCurrentUnifiedItemState(item, staged) === "disabled";
      }
      return (item.extensionSummary?.disabled ?? 0) > 0;
    case "favorites":
      return favoriteIds.has(item.id);
    case "recent":
      return recentIds.has(item.id);
  }
}

function getUnifiedItemSearchFields(
  item: UnifiedItem,
  staged: Map<string, State>,
  cwd: string
): { primary: string[]; secondary: string[] } {
  if (item.type === "local") {
    const state = getCurrentUnifiedItemState(item, staged) ?? item.state;
    return {
      primary: [item.displayName, compactDisplayPath(getLocalItemCurrentPath(item, state), cwd)],
      secondary: [item.summary],
    };
  }

  const source =
    getPackageSourceKind(item.source) === "local"
      ? compactDisplayPath(item.source, cwd)
      : item.source;
  return {
    primary: [item.displayName, source],
    secondary: [
      item.version ?? "",
      item.description ?? "",
      formatPackageExtensionState(item.extensionSummary) ?? "",
      item.extensionSummary
        ? item.extensionSummary.disabled > 0
          ? item.extensionSummary.enabled > 0
            ? "mixed disabled"
            : "disabled"
          : "enabled"
        : "",
    ],
  };
}

function scoreUnifiedItemSearchMatch(
  item: UnifiedItem,
  query: string,
  staged: Map<string, State>,
  cwd: string
): number | undefined {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return 0;
  }

  const fields = getUnifiedItemSearchFields(item, staged, cwd);
  const primary = fields.primary
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const secondary = fields.secondary
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  let totalScore = 0;

  for (const token of tokens) {
    const primarySubstringScore = primary.reduce<number | undefined>((best, field) => {
      const index = field.indexOf(token);
      if (index < 0) {
        return best;
      }
      return best === undefined ? index : Math.min(best, index);
    }, undefined);
    if (primarySubstringScore !== undefined) {
      totalScore += primarySubstringScore;
      continue;
    }

    const secondarySubstringScore = secondary.reduce<number | undefined>((best, field) => {
      const index = field.indexOf(token);
      if (index < 0) {
        return best;
      }
      const score = 100 + index;
      return best === undefined ? score : Math.min(best, score);
    }, undefined);
    if (secondarySubstringScore !== undefined) {
      totalScore += secondarySubstringScore;
      continue;
    }

    const primaryFuzzyScore = primary.reduce<number | undefined>((best, field) => {
      const match = fuzzyMatch(token, field);
      if (!match.matches) {
        return best;
      }
      const score = 200 + match.score;
      return best === undefined ? score : Math.min(best, score);
    }, undefined);
    if (primaryFuzzyScore !== undefined) {
      totalScore += primaryFuzzyScore;
      continue;
    }

    return undefined;
  }

  return totalScore;
}

export function searchUnifiedItems(
  items: UnifiedItem[],
  query: string,
  staged: Map<string, State>,
  cwd: string
): UnifiedItem[] {
  const matches = items
    .map((item, index) => ({
      item,
      index,
      score: scoreUnifiedItemSearchMatch(item, query, staged, cwd),
    }))
    .filter(
      (match): match is { item: UnifiedItem; index: number; score: number } =>
        match.score !== undefined
    );

  matches.sort((a, b) => a.score - b.score || a.index - b.index);
  return matches.map((match) => match.item);
}
