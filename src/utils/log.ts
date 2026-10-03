/**
 * Diagnostics for background failures that have no command context to notify.
 *
 * pi 1.0 draws its interactive TUI on the alternate screen by default, and any
 * stray console write corrupts that frame, so these warnings are dropped while
 * the TUI owns the terminal. In print, json and RPC modes pi redirects stdout
 * to stderr, so writing there is safe.
 */
let consoleDiagnostics = true;

/** Called on session_start: diagnostics stay off while pi runs the TUI. */
export function setConsoleDiagnosticsEnabled(enabled: boolean): void {
  consoleDiagnostics = enabled;
}

export function logWarning(message: string, error?: unknown): void {
  if (!consoleDiagnostics) return;
  if (error === undefined) {
    console.warn(`[extmgr] ${message}`);
  } else {
    console.warn(`[extmgr] ${message}`, error);
  }
}
