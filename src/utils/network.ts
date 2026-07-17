import { open, rm } from "node:fs/promises";

export const MAX_COMPRESSED_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;
  let rejectTimeout!: (error: Error) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`));
  }, timeoutMs);
  const cancellationPromise = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true }
        );
      })
    : undefined;

  try {
    const operation = (async (): Promise<Response> => {
      const response = await fetch(url, { signal: combinedSignal });
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    operation.catch(() => undefined);
    return await Promise.race([
      operation,
      timeoutPromise,
      ...(cancellationPromise ? [cancellationPromise] : []),
    ]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && signal?.aborted) throw error;
    if (timedOut) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream a compressed download to disk with an independent size limit. */
export async function downloadToFile(
  url: string,
  destination: string,
  timeoutMs: number,
  maxBytes = MAX_COMPRESSED_DOWNLOAD_BYTES,
  signal?: AbortSignal
): Promise<void> {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let completed = false;

  try {
    const response = await fetch(url, { signal: combinedSignal });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`);
    }
    if (!response.body) throw new Error("Download failed: response has no body");

    handle = await open(destination, "w");
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new Error(`Download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`);
      }
      await handle.write(chunk.value);
    }
    completed = true;
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => undefined);
    if (!completed) await rm(destination, { force: true }).catch(() => undefined);
  }
}
