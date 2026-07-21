import { type ProgressEvent } from "@earendil-works/pi-coding-agent";

export function getProgressMessage(event: ProgressEvent, fallback: string): string {
  return event.message?.trim() || fallback;
}
