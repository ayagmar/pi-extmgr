import {
  DefaultPackageManager,
  getAgentDir,
  type ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function normalizeSource(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

/** Resolve configured package extensions through Pi without installing missing sources. */
export async function resolveConfiguredPackageExtensions(
  cwd: string,
  projectTrusted: boolean
): Promise<ResolvedResource[]> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  try {
    return (await packageManager.resolve(async () => "skip")).extensions;
  } catch {
    return [];
  }
}

export function resourcesForPackage(
  resources: ResolvedResource[],
  source: string,
  scope: "global" | "project"
): ResolvedResource[] {
  const expectedScope = scope === "project" ? "project" : "user";
  const expectedSource = normalizeSource(source);
  return resources.filter(
    (resource) =>
      resource.metadata.scope === expectedScope &&
      normalizeSource(resource.metadata.source) === expectedSource
  );
}
