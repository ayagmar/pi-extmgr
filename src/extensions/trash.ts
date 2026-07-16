import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TrashRecord {
  originalPath: string;
  trashPath: string;
  trashedAt: number;
}

export async function moveToExtensionTrash(path: string, trashRoot: string): Promise<TrashRecord> {
  await mkdir(trashRoot, { recursive: true });
  const trashPath = join(trashRoot, `${Date.now()}-${basename(path)}`);
  await rename(path, trashPath);
  return { originalPath: path, trashPath, trashedAt: Date.now() };
}

export async function undoExtensionTrash(record: TrashRecord): Promise<void> {
  await mkdir(dirname(record.originalPath), { recursive: true });
  await rename(record.trashPath, record.originalPath);
}

export async function purgeExtensionTrash(record: TrashRecord): Promise<void> {
  await rm(record.trashPath, { recursive: true, force: true });
}
