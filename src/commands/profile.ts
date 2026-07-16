import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getInstalledPackagesAllScopes } from "../packages/discovery.js";
import { planProfileApplication } from "../profiles/apply.js";
import { type ExtmgrProfile, normalizeProfile } from "../profiles/schema.js";
import { notify } from "../utils/notify.js";

const PROFILE_USAGE = "Usage: /extensions profile <export|dry-run|compare> <path>";

async function currentProfile(ctx: ExtensionCommandContext): Promise<ExtmgrProfile> {
  const packages = await getInstalledPackagesAllScopes(ctx);
  return normalizeProfile({
    name: "current",
    packages: packages.map((pkg) => ({
      source: pkg.source,
      scope: pkg.scope,
      ...(pkg.version ? { version: pkg.version } : {}),
    })),
  });
}

async function readProfile(path: string): Promise<ExtmgrProfile> {
  return normalizeProfile(JSON.parse(await readFile(path, "utf8")));
}

function formatPlan(plan: ReturnType<typeof planProfileApplication>): string {
  return [
    `Add: ${plan.add.length}`,
    ...plan.add.map((pkg) => `  + ${pkg.source} (${pkg.scope})`),
    `Remove: ${plan.remove.length}`,
    ...plan.remove.map((pkg) => `  - ${pkg.source} (${pkg.scope})`),
    `Change: ${plan.update.length}`,
    ...plan.update.map(({ to }) => `  ~ ${to.source} (${to.scope})`),
  ].join("\n");
}

export async function handleProfileSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const action = tokens[0];
  const requestedPath = tokens[1];
  if (!action || !requestedPath || !["export", "dry-run", "compare"].includes(action)) {
    notify(ctx, PROFILE_USAGE, "info");
    return;
  }

  const path = resolve(ctx.cwd, requestedPath);
  try {
    const current = await currentProfile(ctx);
    if (action === "export") {
      await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
      notify(ctx, `Exported profile to ${path}`, "info");
      return;
    }

    const desired = await readProfile(path);
    notify(ctx, formatPlan(planProfileApplication(current, desired)), "info");
  } catch (error) {
    notify(
      ctx,
      `Profile ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
  }
}
