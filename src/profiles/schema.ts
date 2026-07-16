export interface ProfilePackage {
  source: string;
  scope: "global" | "project";
  version?: string;
  ref?: string;
  filters?: string[];
  checksum?: string;
}

export interface ExtmgrProfile {
  schemaVersion: 1;
  name: string;
  packages: ProfilePackage[];
  checks?: { compatibility?: boolean; provenance?: boolean };
}

export function normalizeProfile(input: unknown): ExtmgrProfile {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const packages = Array.isArray(value.packages)
    ? value.packages.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const pkg = item as Record<string, unknown>;
        if (typeof pkg.source !== "string" || !pkg.source.trim()) return [];
        const scope: ProfilePackage["scope"] = pkg.scope === "project" ? "project" : "global";
        return [
          {
            source: pkg.source.trim(),
            scope,
            ...(typeof pkg.version === "string" ? { version: pkg.version.trim() } : {}),
            ...(typeof pkg.ref === "string" ? { ref: pkg.ref.trim() } : {}),
            ...(Array.isArray(pkg.filters)
              ? {
                  filters: pkg.filters.filter(
                    (filter): filter is string => typeof filter === "string"
                  ),
                }
              : {}),
            ...(typeof pkg.checksum === "string" ? { checksum: pkg.checksum.trim() } : {}),
          },
        ];
      })
    : [];
  return {
    schemaVersion: 1,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "unnamed",
    packages,
    ...(value.checks && typeof value.checks === "object" && !Array.isArray(value.checks)
      ? {
          checks: {
            compatibility: (value.checks as Record<string, unknown>).compatibility === true,
            provenance: (value.checks as Record<string, unknown>).provenance === true,
          },
        }
      : {}),
  };
}
