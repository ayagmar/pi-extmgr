import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SavedView {
  name: string;
  filter: string;
  searchQuery: string;
  selectedItemId?: string;
  selectedItemIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SavedViewsFile {
  version: 1;
  views: SavedView[];
  favorites: string[];
  recent: string[];
  lastView?: SavedView;
}

const DEFAULT_VIEWS: SavedViewsFile = { version: 1, views: [], favorites: [], recent: [] };
const WRITE_QUEUES = new Map<string, Promise<void>>();

export function normalizeViewsFile(input: unknown): SavedViewsFile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return structuredClone(DEFAULT_VIEWS);
  const value = input as Record<string, unknown>;
  const normalizeView = (candidate: unknown): SavedView | undefined => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.filter !== "string" ||
      typeof value.searchQuery !== "string"
    ) {
      return undefined;
    }
    const now = Date.now();
    return {
      name: value.name.trim(),
      filter: value.filter,
      searchQuery: value.searchQuery,
      ...(typeof value.selectedItemId === "string" && value.selectedItemId.trim()
        ? { selectedItemId: value.selectedItemId.trim() }
        : {}),
      ...(Array.isArray(value.selectedItemIds)
        ? {
            selectedItemIds: value.selectedItemIds.filter(
              (id): id is string => typeof id === "string" && Boolean(id.trim())
            ),
          }
        : {}),
      createdAt:
        typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
          ? value.createdAt
          : now,
      updatedAt:
        typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : now,
    };
  };
  const views = Array.isArray(value.views)
    ? value.views.flatMap((view) => {
        const normalized = normalizeView(view);
        return normalized ? [normalized] : [];
      })
    : [];
  const strings = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim())
      : [];
  const lastView = normalizeView(value.lastView);
  return {
    version: 1,
    views,
    favorites: strings(value.favorites),
    recent: strings(value.recent).slice(0, 20),
    ...(lastView ? { lastView } : {}),
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
  const previous = WRITE_QUEUES.get(path) ?? Promise.resolve();
  const write = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(normalizeViewsFile(data), null, 2)}\n`, "utf8");
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  });
  WRITE_QUEUES.set(
    path,
    write.catch(() => undefined)
  );
  await write;
}

export function getSavedViewsPath(cwd?: string): string {
  const directory = process.env.PI_EXTMGR_CACHE_DIR
    ? process.env.PI_EXTMGR_CACHE_DIR
    : join(homedir(), ".pi", "agent", ".extmgr-cache");
  const suffix = cwd ? `-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}` : "";
  return join(directory, `views${suffix}.json`);
}
