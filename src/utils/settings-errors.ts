import { type SettingsManager } from "@earendil-works/pi-coding-agent";

export function throwIfSettingsErrors(settings: SettingsManager, operation: string): void {
  const errors = settings.drainErrors();
  if (errors.length === 0) return;

  throw new Error(
    `${operation} refused because Pi settings could not be read or written: ${errors
      .map(({ scope, error }) => `${scope}: ${error.message}`)
      .join("; ")}`
  );
}
