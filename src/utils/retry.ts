/**
 * Retry utilities for async operations
 */

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoff?: "fixed" | "linear" | "exponential";
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T | undefined>,
  options: RetryOptions = {}
): Promise<T | undefined> {
  const { maxAttempts = 5, delayMs = 100, backoff = "exponential" } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await operation();
    if (result !== undefined) {
      return result;
    }

    if (attempt < maxAttempts) {
      const delay =
        backoff === "exponential"
          ? delayMs * Math.pow(2, attempt - 1)
          : backoff === "linear"
            ? delayMs * attempt
            : delayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return undefined;
}

/**
 * Wait for a condition to be true with timeout
 */
export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  options: RetryOptions = {}
): Promise<boolean> {
  const result = await retryWithBackoff(async () => {
    const value = await condition();
    return value ? true : undefined;
  }, options);
  return result === true;
}
