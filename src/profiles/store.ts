import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getExtmgrCacheDir } from "../utils/pi-paths.js";
import { type ExtmgrProfile, normalizeProfile, parseExternalProfile } from "./schema.js";

export interface ProfileStoreFile {
  version: 1;
  profiles: Record<string, ExtmgrProfile>;
}

export interface ProfileRestorePoint {
  id: string;
  createdAt: number;
  reason: string;
  profile: ExtmgrProfile;
  incomplete?: boolean;
}

interface RestorePointFile {
  version: 1;
  restorePoints: ProfileRestorePoint[];
}

const MAX_RESTORE_POINTS = 5;
const writeQueues = new Map<string, Promise<void>>();

function safeDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyStore(): ProfileStoreFile {
  return { version: 1, profiles: safeDictionary<ExtmgrProfile>() };
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.hasOwn(object, key);
}

export function normalizeProfileStore(input: unknown): ProfileStoreFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyStore();
  const value = input as Record<string, unknown>;
  if (value.version !== 1) return emptyStore();
  const profilesValue = value.profiles;
  if (!profilesValue || typeof profilesValue !== "object" || Array.isArray(profilesValue)) {
    return emptyStore();
  }
  const profiles = safeDictionary<ExtmgrProfile>();
  for (const [rawName, rawProfile] of Object.entries(profilesValue)) {
    const name = rawName.trim();
    if (!name) continue;
    const profile = normalizeProfile(rawProfile);
    profiles[name] = { ...profile, name };
  }
  return { version: 1, profiles };
}

function parseProfileStore(input: unknown, path: string): ProfileStoreFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Unsupported or malformed profile store: ${path}`);
  }
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !value.profiles ||
    typeof value.profiles !== "object" ||
    Array.isArray(value.profiles)
  ) {
    throw new Error(`Unsupported or malformed profile store: ${path}`);
  }
  const profiles = safeDictionary<ExtmgrProfile>();
  for (const [rawName, rawProfile] of Object.entries(value.profiles)) {
    const name = rawName.trim();
    if (!name)
      throw new Error(`Unsupported or malformed profile store: ${path} (empty profile name)`);
    if (hasOwn(profiles, name))
      throw new Error(`Unsupported or malformed profile store: ${path} (duplicate profile name)`);
    const migrated = parseExternalProfile(
      rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile)
        ? { ...(rawProfile as Record<string, unknown>), name }
        : rawProfile
    );
    if (!migrated.ok) {
      throw new Error(
        `Unsupported or malformed profile store: ${path} (${name}: ${migrated.errors.map((issue) => issue.message).join("; ")})`
      );
    }
    profiles[name] = { ...migrated.profile, name };
  }
  return { version: 1, profiles };
}

export async function readProfileStore(path: string): Promise<ProfileStoreFile> {
  try {
    return parseProfileStore(JSON.parse(await readFile(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyStore();
    if (error instanceof Error && error.message.startsWith("Unsupported or malformed")) throw error;
    throw new Error(
      `Unable to read profile store ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writeAtomically(path: string, value: unknown, label: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.${label}.tmp`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function enqueueWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let result!: T;
  const next = previous.then(async () => {
    result = await operation();
  });
  writeQueues.set(
    path,
    next.catch(() => undefined)
  );
  await next;
  return result;
}

export async function writeProfileStore(path: string, store: ProfileStoreFile): Promise<void> {
  const normalized = parseProfileStore(store, path);
  await enqueueWrite(path, () => writeAtomically(path, normalized, "profiles"));
}

export async function saveNamedProfile(
  path: string,
  profile: ExtmgrProfile,
  options?: { replace?: boolean }
): Promise<ProfileStoreFile> {
  return enqueueWrite(path, async () => {
    const store = await readProfileStore(path);
    if (typeof profile.name !== "string" || !profile.name.trim()) {
      throw new Error("Profile name must not be empty.");
    }
    const normalized = normalizeProfile(profile);
    const validated = parseExternalProfile(normalized);
    if (!validated.ok) {
      throw new Error(
        validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n")
      );
    }
    const name = normalized.name.trim();
    if (!name) throw new Error("Profile name must not be empty.");
    if (hasOwn(store.profiles, name) && options?.replace !== true) {
      throw new Error(`A saved profile named ${name} already exists.`);
    }
    store.profiles[name] = { ...normalized, name };
    const written = parseProfileStore(store, path);
    await writeAtomically(path, written, "profiles");
    return written;
  });
}

export async function deleteNamedProfile(path: string, name: string): Promise<boolean> {
  return enqueueWrite(path, async () => {
    const store = await readProfileStore(path);
    if (!hasOwn(store.profiles, name)) return false;
    delete store.profiles[name];
    const written = parseProfileStore(store, path);
    await writeAtomically(path, written, "profiles");
    return true;
  });
}

export function getNamedProfile(store: ProfileStoreFile, name: string): ExtmgrProfile | undefined {
  return hasOwn(store.profiles, name) ? store.profiles[name] : undefined;
}

export function getProfileStorePath(): string {
  return join(getExtmgrCacheDir(), "profiles.json");
}

export function getProfileRestorePointPath(): string {
  return join(getExtmgrCacheDir(), "profile-restore-points.json");
}

export async function readProfileRestorePoints(
  path = getProfileRestorePointPath()
): Promise<ProfileRestorePoint[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("malformed restore point store");
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.restorePoints))
      throw new Error("unsupported restore point store");
    return value.restorePoints.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const record = raw as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.createdAt !== "number" ||
        typeof record.reason !== "string"
      )
        return [];
      const parsedProfile = parseExternalProfile(record.profile);
      if (!parsedProfile.ok) return [];
      return [
        {
          id: record.id,
          createdAt: record.createdAt,
          reason: record.reason,
          profile: parsedProfile.profile,
          ...(record.incomplete === true ? { incomplete: true } : {}),
        },
      ];
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(
      `Unable to read profile restore points ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function saveProfileRestorePoint(
  profile: ExtmgrProfile,
  reason: string,
  options?: { path?: string; incomplete?: boolean }
): Promise<ProfileRestorePoint> {
  const path = options?.path ?? getProfileRestorePointPath();
  return enqueueWrite(path, async () => {
    const existing = await readProfileRestorePoints(path);
    const point: ProfileRestorePoint = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now(),
      reason,
      profile: normalizeProfile(profile),
      ...(options?.incomplete ? { incomplete: true } : {}),
    };
    const file: RestorePointFile = {
      version: 1,
      restorePoints: [...existing, point].slice(-MAX_RESTORE_POINTS),
    };
    await writeAtomically(path, file, "restore-points");
    return point;
  });
}

export async function markProfileRestorePointIncomplete(
  id: string,
  path = getProfileRestorePointPath()
): Promise<void> {
  await enqueueWrite(path, async () => {
    const points = await readProfileRestorePoints(path);
    const file: RestorePointFile = {
      version: 1,
      restorePoints: points.map((point) =>
        point.id === id ? { ...point, incomplete: true } : point
      ),
    };
    await writeAtomically(path, file, "restore-points");
  });
}
