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

      // `fetch()` resolves after headers arrive. Buffering the body here keeps
      // the timeout active for the complete request, including slow/stalled bodies.
      // extmgr's callers consume finite JSON/text/archive responses rather than
      // streaming them, so returning an equivalent buffered Response is safe.
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
    if (error instanceof Error && error.name === "AbortError" && signal?.aborted) {
      throw error;
    }
    if (timedOut) {
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
