export interface UpdatePolicy {
  packageSource: string;
  enabled: boolean;
  maintenanceWindow?: { startHour: number; endHour: number; timezone?: string };
  digest?: "none" | "daily" | "weekly";
}

export function isWithinMaintenanceWindow(policy: UpdatePolicy, date = new Date()): boolean {
  if (!policy.enabled || !policy.maintenanceWindow) return false;
  const hour = date.getHours();
  const { startHour, endHour } = policy.maintenanceWindow;
  if (startHour === endHour) return true;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function shouldUpdate(policy: UpdatePolicy | undefined, date = new Date()): boolean {
  if (!policy?.enabled) return false;
  return !policy.maintenanceWindow || isWithinMaintenanceWindow(policy, date);
}
