/**
 * Timer utilities for auto-update functionality.
 */

export type TimerCallback = () => void;

let timerId: ReturnType<typeof setInterval> | null = null;

/**
 * Start a recurring timer with the given interval and callback.
 * Clears any existing timer first.
 */
export function startTimer(intervalMs: number, callback: TimerCallback): void {
  stopTimer();

  if (intervalMs <= 0) return;

  timerId = setInterval(callback, intervalMs);
}

/**
 * Stop the current timer if running.
 */
export function stopTimer(): void {
  if (!timerId) return;

  clearInterval(timerId);
  timerId = null;
}

/**
 * Check if a timer is currently running.
 */
export function isTimerRunning(): boolean {
  return timerId !== null;
}
