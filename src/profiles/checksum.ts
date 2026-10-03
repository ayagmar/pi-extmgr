import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PackageManifestSnapshot {
  fingerprint: string;
  version?: string;
}

/** Read the installed manifest once for reproducibility and drift diagnostics. */
export async function readPackageManifestSnapshot(
  path: string | undefined
): Promise<PackageManifestSnapshot | undefined> {
  if (!path) return undefined;
  try {
    const manifest = await readFile(
      /(?:^|[\\/])package\.json$/i.test(path) ? path : join(path, "package.json")
    );
    let version: unknown;
    try {
      const parsed = JSON.parse(manifest.toString("utf8")) as unknown;
      version =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).version
          : undefined;
    } catch {
      // The fingerprint remains useful even when the manifest cannot be parsed.
    }
    return {
      fingerprint: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
      ...(typeof version === "string" && version.trim() ? { version: version.trim() } : {}),
    };
  } catch {
    return undefined;
  }
}
