import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchBoundedBytes, MAX_PROFILE_BYTES } from "../utils/network.js";

export const PROFILE_FETCH_TIMEOUT_MS = 30_000;

export interface LoadedProfileSource {
  value: unknown;
  raw: string;
  origin: string;
  finalOrigin: string;
  fetchedAt?: string;
  contentFingerprint: string;
  immutableOrigin: boolean | "not-applicable";
  warnings: string[];
  remote: boolean;
}

function fingerprint(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rejectUnsupportedTransport(source: string): void {
  if (/^(?:git:|git\+|ssh:|git@)/i.test(source)) {
    throw new Error(
      "Profile sources support local JSON paths and HTTPS URLs only; git and SSH transports are not supported."
    );
  }
}

export function normalizeProfileSourceUrl(source: string): {
  url: URL;
  warnings: string[];
  immutable: boolean;
} {
  rejectUnsupportedTransport(source);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Profile URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Remote profile URLs must use HTTPS.");
  if (url.username || url.password)
    throw new Error("Remote profile URLs must not contain credentials.");

  if (url.hostname.toLowerCase() === "github.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
      throw new Error("GitHub profile URLs must use the /owner/repo/blob/ref/path form.");
    }
    let ref: string;
    try {
      ref = decodeURIComponent(match[3]);
    } catch {
      throw new Error("GitHub profile URL contains an invalid encoded ref.");
    }
    const encodedRef = ref
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    url = new URL(
      `https://raw.githubusercontent.com/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/${encodedRef}/${match[4]}`
    );
  }

  const warnings: string[] = [];
  let immutable = false;
  if (url.hostname.toLowerCase() === "raw.githubusercontent.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    const ref = segments[2];
    immutable = Boolean(ref && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref));
    if (!immutable)
      warnings.push(
        "GitHub origin uses a floating ref; prefer an immutable 40- or 64-character commit URL."
      );
  } else {
    warnings.push(
      "Remote profile origin is not content-addressed; prefer an immutable GitHub commit URL."
    );
  }
  return { url, warnings, immutable };
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid profile JSON from ${context}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readBoundedLocalFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error("Profile byte limit must be a finite non-negative number.");
  }
  const handle = await open(path, "r");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Profile ${path} exceeds the ${maxBytes} byte limit.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function loadProfileSource(
  source: string,
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
): Promise<LoadedProfileSource> {
  const requested = source.trim();
  if (!requested) throw new Error("Profile source is required.");
  rejectUnsupportedTransport(requested);
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:/i.test(requested) && !/^[a-zA-Z]:[\\/]/.test(requested);
  const maxBytes = options.maxBytes ?? MAX_PROFILE_BYTES;

  if (!looksLikeUrl) {
    options.signal?.throwIfAborted();
    const path = resolve(options.cwd, requested);
    const bytes = await readBoundedLocalFile(path, maxBytes, options.signal);
    options.signal?.throwIfAborted();
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      value: parseJson(raw, path),
      raw,
      origin: path,
      finalOrigin: path,
      contentFingerprint: fingerprint(bytes),
      immutableOrigin: "not-applicable",
      warnings: [],
      remote: false,
    };
  }

  const normalized = normalizeProfileSourceUrl(requested);
  const loaded = await fetchBoundedBytes(
    normalized.url.href,
    options.timeoutMs ?? PROFILE_FETCH_TIMEOUT_MS,
    maxBytes,
    options.signal,
    "Remote profile"
  );
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
  const final = normalizeProfileSourceUrl(loaded.finalUrl.href);
  const warnings = [...new Set([...normalized.warnings, ...final.warnings])];
  return {
    value: parseJson(raw, normalized.url.href),
    raw,
    origin: requested,
    finalOrigin: loaded.finalUrl.href,
    fetchedAt: new Date().toISOString(),
    contentFingerprint: fingerprint(loaded.bytes),
    immutableOrigin: normalized.immutable && final.immutable,
    warnings,
    remote: true,
  };
}
