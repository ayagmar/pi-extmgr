import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SavedView {
  name: string;
  filter: string;
  searchQuery: string;
  selectedItemId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavedViewsFile {
  version: 1;
  views: SavedView[];
  favorites: string[];
  recent: string[];
}

const DEFAULT_VIEWS: SavedViewsFile = { version: 1, views: [], favorites: [], recent: [] };

export function normalizeViewsFile(input: unknown): SavedViewsFile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return structuredClone(DEFAULT_VIEWS);
  const value = input as Record<string, unknown>;
  const views = Array.isArray(value.views)
    ? value.views
        .filter((view): view is SavedView => {
          if (!view || typeof view !== "object" || Array.isArray(view)) return false;
          const candidate = view as Record<string, unknown>;
          return (
            typeof candidate.name === "string" &&
            typeof candidate.filter === "string" &&
            typeof candidate.searchQuery === "string"
          );
        })
        .map((view) => ({ ...view, name: view.name.trim() }))
        .filter((view) => view.name.length > 0)
    : [];
  const strings = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim())
      : [];
  return {
    version: 1,
    views,
    favorites: strings(value.favorites),
    recent: strings(value.recent).slice(0, 20),
  };
}

export async function readSavedViews(path: string): Promise<SavedViewsFile> {
  try {
    return normalizeViewsFile(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return structuredClone(DEFAULT_VIEWS);
  }
}

export async function writeSavedViews(path: string, data: SavedViewsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(normalizeViewsFile(data), null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
