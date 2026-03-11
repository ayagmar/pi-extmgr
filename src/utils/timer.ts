/**
 * Timer utilities for auto-update functionality.
 */

export type TimerCallback = () => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

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
    intervalId = setInterval(callback, intervalMs);
    callback();
  };

  const initialDelayMs = options?.initialDelayMs ?? 0;
  if (initialDelayMs <= 0) {
    runAndReschedule();
    return;
  }

  timeoutId = setTimeout(() => {
    timeoutId = null;
    runAndReschedule();
  }, initialDelayMs);
}

/**
 * Stop the current timer if running.
 */
export function stopTimer(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Check if a timer is currently running.
 */
export function isTimerRunning(): boolean {
  return timeoutId !== null || intervalId !== null;
}
