import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const VALID_RELEASE_TYPES = ["patch", "minor", "major"] as const;

type ReleaseType = (typeof VALID_RELEASE_TYPES)[number];

export function normalizeReleaseType(rawReleaseType: unknown): ReleaseType {
  const releaseType = typeof rawReleaseType === "string" ? rawReleaseType.trim().toLowerCase() : "";

  if (!VALID_RELEASE_TYPES.includes(releaseType as ReleaseType)) {
    throw new Error(
      `Invalid RELEASE_TYPE: ${JSON.stringify(rawReleaseType)}. Expected one of: ${VALID_RELEASE_TYPES.join(", ")}`
    );
  }

  return releaseType as ReleaseType;
}

export function parseFirstRelease(rawFirstRelease: unknown): boolean {
  return typeof rawFirstRelease === "string" && rawFirstRelease.trim().toLowerCase() === "true";
}

export function buildReleaseItArgs(options: {
  releaseType: unknown;
  firstRelease: boolean;
}): string[] {
  const args = ["exec", "release-it", normalizeReleaseType(options.releaseType), "--ci"];

  if (options.firstRelease) {
    args.push("--first-release");
  }

  return args;
}

function run(): never {
  const args = buildReleaseItArgs({
    releaseType: process.env.RELEASE_TYPE,
    firstRelease: parseFirstRelease(process.env.FIRST_RELEASE),
  });

  console.log(`[release-ci] Running: pnpm ${args.join(" ")}`);

  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }

  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run();
}
