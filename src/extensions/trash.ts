import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TrashRecord {
  originalPath: string;
  trashPath: string;
  trashedAt: number;
}

interface TrashFile {
  version: 1;
  records: TrashRecord[];
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const writeQueues = new Map<string, Promise<void>>();

function recordsPath(trashRoot: string): string {
  return join(trashRoot, "records.json");
}

function normalizeRecord(value: unknown): TrashRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.originalPath !== "string" ||
    typeof record.trashPath !== "string" ||
    typeof record.trashedAt !== "number" ||
    !Number.isFinite(record.trashedAt)
  ) {
    return undefined;
  }
  return {
    originalPath: record.originalPath,
    trashPath: record.trashPath,
    trashedAt: record.trashedAt,
  };
}

function normalizeTrashFile(value: unknown): TrashFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, records: [] };
  }
  const recordsValue = (value as Record<string, unknown>).records;
  const records = Array.isArray(recordsValue)
    ? recordsValue.flatMap((record: unknown) => {
        const normalized = normalizeRecord(record);
        return normalized ? [normalized] : [];
      })
    : [];
  return { version: 1, records };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTrashFile(trashRoot: string): Promise<TrashFile> {
  try {
    return normalizeTrashFile(JSON.parse(await readFile(recordsPath(trashRoot), "utf8")));
  } catch {
    return { version: 1, records: [] };
  }
}

async function writeTrashFile(trashRoot: string, file: TrashFile): Promise<void> {
  await mkdir(trashRoot, { recursive: true });
  const path = recordsPath(trashRoot);
  const temporary = join(trashRoot, `.${process.pid}.${Date.now()}.records.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function updateTrashFile(
  trashRoot: string,
  update: (file: TrashFile) => TrashFile | Promise<TrashFile>
): Promise<void> {
  const previous = writeQueues.get(trashRoot) ?? Promise.resolve();
  const next = previous.then(async () =>
    writeTrashFile(trashRoot, await update(await readTrashFile(trashRoot)))
  );
  writeQueues.set(
    trashRoot,
    next.catch(() => undefined)
  );
  await next;
}

export async function moveToExtensionTrash(path: string, trashRoot: string): Promise<TrashRecord> {
  await mkdir(trashRoot, { recursive: true });
  let trashPath = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    trashPath = join(
      trashRoot,
      `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${basename(path)}`
    );
    if (!(await fileExists(trashPath))) break;
  }

  await rename(path, trashPath);
  const record: TrashRecord = { originalPath: path, trashPath, trashedAt: Date.now() };
  try {
    await updateTrashFile(trashRoot, (file) => ({
      version: 1,
      records: [...file.records.filter((item) => item.trashPath !== trashPath), record],
    }));
  } catch (error) {
    try {
      if (!(await fileExists(path))) {
        await rename(trashPath, path);
      }
    } catch (rollbackError) {
      throw new Error(
        `Trash record could not be saved and the extension could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
    }
    throw error;
  }
  return record;
}

export async function listExtensionTrash(
  trashRoot: string,
  options?: { now?: number; retentionMs?: number }
): Promise<TrashRecord[]> {
  const now = options?.now ?? Date.now();
  const retentionMs = options?.retentionMs ?? TRASH_RETENTION_MS;
  const file = await readTrashFile(trashRoot);
  const kept: TrashRecord[] = [];
  for (const record of file.records) {
    const expired = now - record.trashedAt >= retentionMs;
    if (expired || !(await fileExists(record.trashPath))) {
      if (expired) await rm(record.trashPath, { recursive: true, force: true });
      continue;
    }
    kept.push(record);
  }

  if (kept.length !== file.records.length) {
    await updateTrashFile(trashRoot, () => ({ version: 1, records: kept }));
  }
  return kept;
}

export async function undoExtensionTrash(record: TrashRecord): Promise<void> {
  if (await fileExists(record.originalPath)) {
    throw new Error(`Cannot undo removal: ${record.originalPath} already exists.`);
  }
  if (!(await fileExists(record.trashPath))) {
    throw new Error("Cannot undo removal: the trash entry is missing or expired.");
  }

  await mkdir(dirname(record.originalPath), { recursive: true });
  await rename(record.trashPath, record.originalPath);
  await removeTrashRecord(record);
}

export async function purgeExtensionTrash(record: TrashRecord): Promise<void> {
  await rm(record.trashPath, { recursive: true, force: true });
  await removeTrashRecord(record);
}

async function removeTrashRecord(record: TrashRecord): Promise<void> {
  const trashRoot = dirname(record.trashPath);
  await updateTrashFile(trashRoot, (file) => ({
    version: 1,
    records: file.records.filter((item) => item.trashPath !== record.trashPath),
  }));
}
