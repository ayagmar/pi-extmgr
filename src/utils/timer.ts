/**
 * Timer utilities for auto-update functionality
 * Provides a safe wrapper around setInterval with proper cleanup
 */

export type TimerCallback = () => void;

interface TimerState {
  timerId: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
}

const state: TimerState = {
  timerId: null,
  isRunning: false,
};

/**
 * Start a recurring timer with the given interval and callback
 * Automatically clears any existing timer before starting
 */
export function startTimer(intervalMs: number, callback: TimerCallback): void {
  stopTimer();

  if (intervalMs <= 0) {
    return;
  }

  state.timerId = setInterval(callback, intervalMs);
  state.isRunning = true;
}

/**
 * Stop the current timer if running
 */
export function stopTimer(): void {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.isRunning = false;
}

/**
 * Check if a timer is currently running
 */
export function isTimerRunning(): boolean {
  return state.isRunning;
}

/**
 * Execute a callback once after a delay without affecting the recurring timer
 */
export function runOnce(delayMs: number, callback: TimerCallback): void {
  if (delayMs <= 0) {
    callback();
    return;
  }
  setTimeout(callback, delayMs);
}
