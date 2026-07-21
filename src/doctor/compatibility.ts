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

type Version = [number, number, number];
type Comparator = { operator: ">=" | ">" | "<=" | "<" | "="; version: Version };

function parseVersion(value: string, allowPartial = false): Version | undefined {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match?.[1]) return undefined;
  if (!allowPartial && (match[2] === undefined || match[3] === undefined)) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function testComparator(actual: Version, comparator: Comparator): boolean {
  const result = compare(actual, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return result >= 0;
    case ">":
      return result > 0;
    case "<=":
      return result <= 0;
    case "<":
      return result < 0;
    case "=":
      return result === 0;
  }
}

function expandToken(token: string): Comparator[] | undefined {
  const caret = token.match(/^\^(.+)$/);
  const tilde = token.match(/^~(.+)$/);
  if (caret?.[1] || tilde?.[1]) {
    const value = caret?.[1] ?? tilde?.[1];
    if (!value) return undefined;
    const version = parseVersion(value, true);
    if (!version) return undefined;
    let upper: Version;
    if (caret) {
      upper =
        version[0] > 0
          ? [version[0] + 1, 0, 0]
          : version[1] > 0
            ? [0, version[1] + 1, 0]
            : [0, 0, version[2] + 1];
    } else {
      upper = [version[0], version[1] + 1, 0];
    }
    return [
      { operator: ">=", version },
      { operator: "<", version: upper },
    ];
  }
  const match = token.match(/^(>=|<=|>|<|=)?(v?\d+(?:\.\d+){0,2})$/);
  if (!match?.[2]) return undefined;
  const operator = (match[1] ?? "=") as Comparator["operator"];
  const version = parseVersion(match[2], operator !== "=");
  return version ? [{ operator, version }] : undefined;
}

function satisfiesRange(
  actualValue: string | undefined,
  range: string | undefined
): boolean | undefined {
  if (!actualValue || !range) return undefined;
  if (/\|\||\s+-\s+|!=|\*|\bx\b/i.test(range) || /\d-/.test(range) || /\d-/.test(actualValue))
    return undefined;
  const actual = parseVersion(actualValue.replace(/^v/, ""));
  if (!actual) return undefined;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const expanded = expandToken(token);
    if (!expanded) return undefined;
    comparators.push(...expanded);
  }
  return comparators.every((comparator) => testComparator(actual, comparator));
}

export function validateCompatibility(input: CompatibilityInput): CompatibilityDiagnostic {
  const reasons: string[] = [];
  const nodeCompatible = satisfiesRange(input.nodeVersion, input.engines?.node);
  const piCompatible = satisfiesRange(input.piVersion, input.requiredPi);
  const node =
    nodeCompatible === undefined ? "unknown" : nodeCompatible ? "compatible" : "incompatible";
  const pi = piCompatible === undefined ? "unknown" : piCompatible ? "compatible" : "incompatible";
  if (node === "incompatible") reasons.push(`requires Node ${input.engines?.node}`);
  if (pi === "incompatible") reasons.push(`requires Pi ${input.requiredPi}`);
  if (node === "unknown" && input.engines?.node)
    reasons.push(`unsupported or ambiguous Node range ${input.engines.node}`);
  if (pi === "unknown" && input.requiredPi)
    reasons.push(`unsupported or ambiguous Pi range ${input.requiredPi}`);
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
