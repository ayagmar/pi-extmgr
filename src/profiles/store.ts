import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getExtmgrCacheDir } from "../utils/pi-paths.js";
import { type ExtmgrProfile, normalizeProfile } from "./schema.js";

export interface ProfileStoreFile {
  version: 1;
  profiles: Record<string, ExtmgrProfile>;
}

const writeQueues = new Map<string, Promise<void>>();

function emptyStore(): ProfileStoreFile {
  return { version: 1, profiles: {} };
}

export function normalizeProfileStore(input: unknown): ProfileStoreFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyStore();
  const value = input as Record<string, unknown>;
  if (value.version !== 1) return emptyStore();
  const profilesValue = value.profiles;
  if (!profilesValue || typeof profilesValue !== "object" || Array.isArray(profilesValue)) {
    return emptyStore();
  }
  const profiles: Record<string, ExtmgrProfile> = {};
  for (const [name, value] of Object.entries(profilesValue)) {
    if (!name.trim()) continue;
    const profile = normalizeProfile(value);
    if (profile.packages.length > 0 || profile.name !== "unnamed") {
      profiles[name.trim()] = { ...profile, name: name.trim() };
    }
  }
  return { version: 1, profiles };
}

export async function readProfileStore(path: string): Promise<ProfileStoreFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 1
    ) {
      throw new Error(`Unsupported or malformed profile store: ${path}`);
    }
    return normalizeProfileStore(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyStore();
    }
    if (error instanceof Error && error.message.startsWith("Unsupported or malformed")) {
      throw error;
    }
    throw new Error(
      `Unable to read profile store ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function writeProfileStore(path: string, store: ProfileStoreFile): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.profiles.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(normalizeProfileStore(store), null, 2)}\n`,
        "utf8"
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  writeQueues.set(
    path,
    next.catch(() => undefined)
  );
  await next;
}

export async function saveNamedProfile(
  path: string,
  profile: ExtmgrProfile
): Promise<ProfileStoreFile> {
  const store = await readProfileStore(path);
  const normalized = normalizeProfile(profile);
  store.profiles[normalized.name] = normalized;
  await writeProfileStore(path, store);
  return store;
}

export async function deleteNamedProfile(path: string, name: string): Promise<boolean> {
  const store = await readProfileStore(path);
  if (!store.profiles[name]) return false;
  delete store.profiles[name];
  await writeProfileStore(path, store);
  return true;
}

export function getProfileStorePath(): string {
  const directory = getExtmgrCacheDir();
  return join(directory, "profiles.json");
}
