import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getExtmgrCacheDir } from "./pi-paths.js";

export interface ReloadRequiredState {
  version: 1;
  required: boolean;
  changedAt?: number;
  changes: number;
  reasons: string[];
}

const DEFAULT_STATE: ReloadRequiredState = {
  version: 1,
  required: false,
  changes: 0,
  reasons: [],
};

function stateDir(): string {
  return getExtmgrCacheDir();
}

function stateFile(): string {
  return join(stateDir(), "reload-required.json");
}

let writeQueue: Promise<void> = Promise.resolve();

function cloneDefault(): ReloadRequiredState {
  return { ...DEFAULT_STATE, reasons: [] };
}

function normalizeState(input: unknown): ReloadRequiredState {
  if (!input || typeof input !== "object" || Array.isArray(input)) return cloneDefault();
  const value = input as Record<string, unknown>;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason): reason is string => typeof reason === "string").slice(-8)
    : [];
  return {
    version: 1,
    required: value.required === true,
    ...(typeof value.changedAt === "number" && Number.isFinite(value.changedAt)
      ? { changedAt: value.changedAt }
      : {}),
    changes:
      typeof value.changes === "number" && Number.isInteger(value.changes) && value.changes >= 0
        ? value.changes
        : 0,
    reasons,
  };
}

async function readStateFromDisk(path: string): Promise<ReloadRequiredState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return cloneDefault();
  }
}

async function writeStateToDisk(path: string, state: ReloadRequiredState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.reload.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readReloadState(path = stateFile()): Promise<ReloadRequiredState> {
  await writeQueue;
  return readStateFromDisk(path);
}

export async function markReloadRequired(reason: string, path = stateFile()): Promise<void> {
  const normalizedReason = reason.trim() || "Extension configuration changed";
  writeQueue = writeQueue.then(async () => {
    const current = await readStateFromDisk(path);
    const reasons = [
      ...current.reasons.filter((item) => item !== normalizedReason),
      normalizedReason,
    ];
    await writeStateToDisk(path, {
      version: 1,
      required: true,
      changedAt: Date.now(),
      changes: current.changes + 1,
      reasons: reasons.slice(-8),
    });
  });
  await writeQueue;
}

export async function clearReloadRequired(path = stateFile()): Promise<void> {
  writeQueue = writeQueue.then(() => writeStateToDisk(path, cloneDefault()));
  await writeQueue;
}

export function getReloadRequiredStatePath(): string {
  return stateFile();
}
