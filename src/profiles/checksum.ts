import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function checksumPackagePath(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const manifest = await readFile(
      /(?:^|[\\/])package\.json$/i.test(path) ? path : join(path, "package.json")
    );
    return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  } catch {
    return undefined;
  }
}

export async function verifyPackageChecksum(
  path: string | undefined,
  expected: string | undefined
): Promise<"match" | "mismatch" | "unknown"> {
  if (!expected) return "unknown";
  const actual = await checksumPackagePath(path);
  if (!actual) return "unknown";
  return actual === expected ? "match" : "mismatch";
}
