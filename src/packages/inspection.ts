export interface PackageInspection {
  name: string;
  version?: string;
  description?: string;
  dependencies: string[];
  repository?: string;
  provenance: "verified" | "unverified" | "unknown";
  compatibility: "compatible" | "incompatible" | "unknown";
}

export function inspectPackageMetadata(input: {
  name: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  repository?: string;
  hasProvenance?: boolean;
  compatibility?: "compatible" | "incompatible";
}): PackageInspection {
  return {
    name: input.name,
    ...(input.version ? { version: input.version } : {}),
    ...(input.description ? { description: input.description } : {}),
    dependencies: Object.keys(input.dependencies ?? {}).sort(),
    ...(input.repository ? { repository: input.repository } : {}),
    provenance: input.hasProvenance === true ? "verified" : "unknown",
    compatibility: input.compatibility ?? "unknown",
  };
}
