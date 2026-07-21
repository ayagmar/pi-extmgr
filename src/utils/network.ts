import { open, rm } from "node:fs/promises";
import { createAbortError as abortError } from "./abort.js";

export const MAX_COMPRESSED_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_METADATA_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_DIRECT_EXTENSION_BYTES = 512 * 1024;
export const MAX_PROFILE_BYTES = 1024 * 1024;

export function assertSafeHttpsUrl(value: string | URL, label = "URL"): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  return url;
}

export function validateFinalHttpsUrl(response: Response, requested: URL): URL {
  const finalUrl = response.url
    ? assertSafeHttpsUrl(response.url, "Final redirected URL")
    : requested;
  if (finalUrl.protocol !== "https:") throw new Error("Final redirected URL must use HTTPS");
  return finalUrl;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    throw abortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

async function fetchResponseWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{
  response: Response;
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
}> {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (signal?.aborted) throw abortError();
    const response = await fetch(url, { signal: combinedSignal, redirect: "follow" });
    return {
      response,
      signal: combinedSignal,
      cleanup: () => clearTimeout(timer),
      timedOut: () => didTimeOut,
    };
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) throw abortError();
    if (didTimeOut) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  }
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBytes = MAX_METADATA_RESPONSE_BYTES
): Promise<Response> {
  const requested = assertSafeHttpsUrl(url);
  const pending = await fetchResponseWithTimeout(requested.href, timeoutMs, signal);
  try {
    const finalUrl = validateFinalHttpsUrl(pending.response, requested);
    const bytes = await readBoundedResponse(pending.response, maxBytes, pending.signal, "Response");
    if (signal?.aborted) throw abortError();
    if (pending.timedOut())
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    const buffered = new Response(bytes, {
      status: pending.response.status,
      statusText: pending.response.statusText,
      headers: pending.response.headers,
    });
    Object.defineProperty(buffered, "url", { configurable: true, value: finalUrl.href });
    return buffered;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (pending.timedOut())
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    pending.cleanup();
    await pending.response.body?.cancel().catch(() => undefined);
  }
}

export async function fetchBoundedBytes(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
  label = "Download"
): Promise<{ bytes: Uint8Array; finalUrl: URL; response: Response }> {
  const requested = assertSafeHttpsUrl(url);
  const pending = await fetchResponseWithTimeout(requested.href, timeoutMs, signal);
  try {
    const finalUrl = validateFinalHttpsUrl(pending.response, requested);
    if (!pending.response.ok) {
      throw new Error(`${label} failed: ${pending.response.status} ${pending.response.statusText}`);
    }
    const bytes = await readBoundedResponse(pending.response, maxBytes, pending.signal, label);
    if (pending.timedOut())
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    return { bytes, finalUrl, response: pending.response };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (pending.timedOut())
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    pending.cleanup();
    await pending.response.body?.cancel().catch(() => undefined);
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  label = "Download"
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} byte limit must be a finite non-negative number`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
  if (!response.body) throw new Error(`${label} failed: response has no body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await readWithSignal(reader, signal);
      signal?.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Stream a download to disk with timeout, cancellation, redirect, and size limits. */
export async function downloadToFile(
  url: string,
  destination: string,
  timeoutMs: number,
  maxBytes = MAX_COMPRESSED_DOWNLOAD_BYTES,
  signal?: AbortSignal
): Promise<void> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error("Download byte limit must be a finite non-negative number");
  }
  const requested = assertSafeHttpsUrl(url);
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let destinationCreated = false;
  let completed = false;

  try {
    if (signal?.aborted) throw abortError();
    response = await fetch(requested.href, { signal: combinedSignal, redirect: "follow" });
    validateFinalHttpsUrl(response, requested);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new Error(`Download exceeds the ${maxBytes} byte limit`);
    if (!response.body) throw new Error("Download failed: response has no body");

    handle = await open(destination, "wx");
    destinationCreated = true;
    reader = response.body.getReader();
    let total = 0;
    while (true) {
      combinedSignal.throwIfAborted();
      const chunk = await readWithSignal(reader, combinedSignal);
      combinedSignal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new Error(`Download exceeds the ${maxBytes} byte limit`);
      }
      await handle.write(chunk.value);
    }
    completed = true;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await response?.body?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    if (!completed && destinationCreated)
      await rm(destination, { force: true }).catch(() => undefined);
  }
}
