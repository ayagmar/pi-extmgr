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
