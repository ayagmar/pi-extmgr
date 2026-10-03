/**
 * Timer utilities for auto-update functionality.
 */

export type TimerCallback = () => void;

/**
 * Node clamps setTimeout/setInterval delays above 2^31-1 ms (~24.8 days) to
 * 1 ms, which would turn a monthly schedule into a tight loop. Longer delays
 * are waited out in chunks of at most this size.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

let timeoutId: ReturnType<typeof setTimeout> | null = null;

/** Wait `delayMs` (any length), then run `onElapsed`, via chunked timeouts. */
function schedule(delayMs: number, onElapsed: () => void): void {
  const step = Math.min(delayMs, MAX_TIMER_DELAY_MS);
  timeoutId = setTimeout(() => {
    timeoutId = null;
    const remaining = delayMs - step;
    if (remaining > 0) {
      schedule(remaining, onElapsed);
    } else {
      onElapsed();
    }
  }, step);
}

/**
 * Start a recurring timer with the given interval and callback.
 * Clears any existing timer first.
 */
export function startTimer(
  intervalMs: number,
  callback: TimerCallback,
  options?: { initialDelayMs?: number }
): void {
  stopTimer();

  if (intervalMs <= 0) return;

  const runAndReschedule = (): void => {
    // Schedule first so the timer stays registered while the callback runs
    // and a stopTimer() from inside the callback still cancels it.
    schedule(intervalMs, runAndReschedule);
    callback();
  };

  const initialDelayMs = options?.initialDelayMs ?? 0;
  if (initialDelayMs <= 0) {
    runAndReschedule();
    return;
  }

  schedule(initialDelayMs, runAndReschedule);
}

/**
 * Stop the current timer if running.
 */
export function stopTimer(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

/**
 * Check if a timer is currently running.
 */
export function isTimerRunning(): boolean {
  return timeoutId !== null;
}
