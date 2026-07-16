import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  const profilesValue = (input as Record<string, unknown>).profiles;
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
    return normalizeProfileStore(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return emptyStore();
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
  const directory = process.env.PI_EXTMGR_CACHE_DIR
    ? process.env.PI_EXTMGR_CACHE_DIR
    : join(homedir(), ".pi", "agent", ".extmgr-cache");
  return join(directory, "profiles.json");
}
