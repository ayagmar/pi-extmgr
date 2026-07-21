import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileExists } from "../utils/fs.js";

export interface TrashRecord {
  originalPath: string;
  trashPath: string;
  trashedAt: number;
}

interface TrashFile {
  version: 1;
  records: TrashRecord[];
}

class TrashMetadataError extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported" | "invalid",
    message: string
  ) {
    super(message);
  }
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const writeQueues = new Map<string, Promise<void>>();

function recordsPath(trashRoot: string): string {
  return join(trashRoot, "records.json");
}

function isContainedPath(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const child = relative(normalizedRoot, normalizedPath);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function normalizeRecord(value: unknown, trashRoot: string): TrashRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.originalPath !== "string" ||
    !record.originalPath ||
    !isAbsolute(record.originalPath) ||
    typeof record.trashPath !== "string" ||
    !isContainedPath(trashRoot, record.trashPath) ||
    typeof record.trashedAt !== "number" ||
    !Number.isFinite(record.trashedAt)
  )
    return undefined;
  return {
    originalPath: record.originalPath,
    trashPath: resolve(record.trashPath),
    trashedAt: record.trashedAt,
  };
}

async function readTrashFile(trashRoot: string): Promise<TrashFile> {
  let raw: string;
  try {
    raw = await readFile(recordsPath(trashRoot), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, records: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TrashMetadataError(
      "malformed",
      `Trash metadata is malformed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TrashMetadataError("malformed", "Trash metadata must be an object.");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1)
    throw new TrashMetadataError(
      "unsupported",
      `Unsupported trash metadata version: ${String(value.version)}`
    );
  if (!Array.isArray(value.records))
    throw new TrashMetadataError("malformed", "Trash metadata records must be an array.");
  const records: TrashRecord[] = [];
  for (const rawRecord of value.records) {
    const record = normalizeRecord(rawRecord, trashRoot);
    if (!record)
      throw new TrashMetadataError(
        "invalid",
        "Trash metadata contains an invalid or unsafe record."
      );
    records.push(record);
  }
  return { version: 1, records };
}

async function writeTrashFile(trashRoot: string, file: TrashFile): Promise<void> {
  await mkdir(trashRoot, { recursive: true });
  for (const record of file.records) {
    if (!normalizeRecord(record, trashRoot))
      throw new Error("Refusing to persist an invalid or non-contained trash record.");
  }
  const path = recordsPath(trashRoot);
  const temporary = join(trashRoot, `.${process.pid}.${Date.now()}.records.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function backupCorruptMetadata(trashRoot: string): Promise<string> {
  const source = recordsPath(trashRoot);
  const backup = join(
    trashRoot,
    `records.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  try {
    await rename(source, backup);
  } catch (error) {
    throw new Error(
      `Trash metadata is corrupt and could not be backed up; no replacement was written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return backup;
}

async function readForUpdate(trashRoot: string): Promise<TrashFile> {
  try {
    return await readTrashFile(trashRoot);
  } catch (error) {
    if (!(error instanceof TrashMetadataError)) throw error;
    await backupCorruptMetadata(trashRoot);
    // Existing orphaned payloads remain untouched. Their original paths cannot
    // be reconstructed safely from legacy filenames, so no identity is invented.
    return { version: 1, records: [] };
  }
}

async function updateTrashFile(
  trashRoot: string,
  update: (file: TrashFile) => TrashFile | Promise<TrashFile>
): Promise<void> {
  const previous = writeQueues.get(trashRoot) ?? Promise.resolve();
  const next = previous.then(async () =>
    writeTrashFile(trashRoot, await update(await readForUpdate(trashRoot)))
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    trashPath = join(
      trashRoot,
      `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${basename(path)}`
    );
    if (!(await fileExists(trashPath))) break;
  }
  if (!trashPath || (await fileExists(trashPath)))
    throw new Error("Unable to allocate a unique trash destination.");

  await rename(path, trashPath);
  const record: TrashRecord = {
    originalPath: resolve(path),
    trashPath: resolve(trashPath),
    trashedAt: Date.now(),
  };
  try {
    await updateTrashFile(trashRoot, (file) => ({
      version: 1,
      records: [...file.records.filter((item) => item.trashPath !== record.trashPath), record],
    }));
  } catch (error) {
    try {
      if (!(await fileExists(path))) await rename(trashPath, path);
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
  if (kept.length !== file.records.length)
    await updateTrashFile(trashRoot, () => ({ version: 1, records: kept }));
  return kept;
}

export async function listExtensionTrashOrphans(trashRoot: string): Promise<string[]> {
  try {
    const records = new Set(
      (await readTrashFile(trashRoot)).records.map((record) => resolve(record.trashPath))
    );
    const entries = await readdir(trashRoot);
    return entries
      .filter(
        (name) =>
          name !== "records.json" && !name.startsWith("records.corrupt-") && !name.startsWith(".")
      )
      .map((name) => resolve(trashRoot, name))
      .filter((path) => !records.has(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function undoExtensionTrash(record: TrashRecord): Promise<void> {
  const trashRoot = dirname(record.trashPath);
  if (!normalizeRecord(record, trashRoot))
    throw new Error("Cannot undo removal: the trash record is unsafe or malformed.");
  if (await fileExists(record.originalPath))
    throw new Error(`Cannot undo removal: ${record.originalPath} already exists.`);
  if (!(await fileExists(record.trashPath)))
    throw new Error("Cannot undo removal: the trash entry is missing or expired.");
  await mkdir(dirname(record.originalPath), { recursive: true });
  await rename(record.trashPath, record.originalPath);
  await removeTrashRecord(record);
}

export async function purgeExtensionTrash(record: TrashRecord): Promise<void> {
  const trashRoot = dirname(record.trashPath);
  if (!normalizeRecord(record, trashRoot))
    throw new Error("Cannot purge an unsafe or malformed trash record.");
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
