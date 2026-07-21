export function createAbortError(message = "Operation cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
