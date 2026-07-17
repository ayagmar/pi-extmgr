import { type SettingsManager } from "@earendil-works/pi-coding-agent";

export function throwIfSettingsErrors(settings: SettingsManager, operation: string): void {
  const errors = settings.drainErrors();
  if (errors.length === 0) return;

  const details = errors
    .map(({ scope, error }) => {
      const message = /JSON|property name|Unexpected token/i.test(error.message)
        ? `Invalid JSON: ${error.message}`
        : error.message;
      return `${scope}: ${message}`;
    })
    .join("; ");
  throw new Error(
    `${operation} refused because Pi settings could not be read or written: ${details}`
  );
}
