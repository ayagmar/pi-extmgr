import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type InstalledPackage } from "../types/index.js";

export interface CompatibilityInput {
  packageName: string;
  engines?: { node?: string };
  piVersion?: string;
  requiredPi?: string;
  nodeVersion?: string;
}

export interface CompatibilityDiagnostic {
  packageName: string;
  node: "compatible" | "incompatible" | "unknown";
  pi: "compatible" | "incompatible" | "unknown";
  reasons: string[];
}

function versionParts(version: string | undefined): [number, number] | undefined {
  const match = version?.match(/(?:^|\s|[>=<~^])v?(\d+)(?:\.(\d+))?/);
  return match?.[1] ? [Number(match[1]), Number(match[2] ?? 0)] : undefined;
}

function isAtLeast(
  actual: [number, number] | undefined,
  required: [number, number] | undefined
): boolean | undefined {
  if (!actual || !required) return undefined;
  return actual[0] > required[0] || (actual[0] === required[0] && actual[1] >= required[1]);
}

export function validateCompatibility(input: CompatibilityInput): CompatibilityDiagnostic {
  const reasons: string[] = [];
  const nodeCompatible = isAtLeast(
    versionParts(input.nodeVersion),
    versionParts(input.engines?.node)
  );
  const piCompatible = isAtLeast(versionParts(input.piVersion), versionParts(input.requiredPi));
  const node =
    nodeCompatible === undefined ? "unknown" : nodeCompatible ? "compatible" : "incompatible";
  const pi = piCompatible === undefined ? "unknown" : piCompatible ? "compatible" : "incompatible";
  if (node === "incompatible") reasons.push(`requires Node ${input.engines?.node}`);
  if (pi === "incompatible") reasons.push(`requires Pi ${input.requiredPi}`);
  return { packageName: input.packageName, node, pi, reasons };
}

export interface InstalledCompatibilityDiagnostic extends CompatibilityDiagnostic {
  scope: "global" | "project";
  source: string;
}

export async function inspectInstalledPackageCompatibility(
  packages: InstalledPackage[],
  options?: { nodeVersion?: string; piVersion?: string }
): Promise<InstalledCompatibilityDiagnostic[]> {
  const diagnostics = await Promise.all(
    packages.map(async (pkg) => {
      let engines: { node?: string } | undefined;
      let requiredPi: string | undefined;
      if (pkg.resolvedPath) {
        try {
          const manifestPath = /(?:^|[\\/])package\.json$/i.test(pkg.resolvedPath)
            ? pkg.resolvedPath
            : join(pkg.resolvedPath, "package.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
            string,
            unknown
          >;
          const manifestEngines = manifest.engines;
          if (
            manifestEngines &&
            typeof manifestEngines === "object" &&
            !Array.isArray(manifestEngines)
          ) {
            const node = (manifestEngines as Record<string, unknown>).node;
            const pi = (manifestEngines as Record<string, unknown>).pi;
            engines = typeof node === "string" ? { node } : undefined;
            requiredPi = typeof pi === "string" ? pi : undefined;
          }
        } catch {
          // Missing or malformed package metadata remains unknown.
        }
      }
      const diagnostic = validateCompatibility({
        packageName: pkg.name,
        ...(engines ? { engines } : {}),
        ...(requiredPi ? { requiredPi } : {}),
        ...(options?.piVersion ? { piVersion: options.piVersion } : {}),
        nodeVersion: options?.nodeVersion ?? process.version,
      });
      return { ...diagnostic, scope: pkg.scope, source: pkg.source };
    })
  );
  return diagnostics.sort((left, right) => left.source.localeCompare(right.source));
}
