export type PermissionLevel = 'READ_ONLY' | 'READ_WRITE' | 'SMART' | 'PROXY' | 'FULL';

export function permissionLevelFromString(value: string | null | undefined): PermissionLevel {
  if (value == null) return 'READ_ONLY';
  if (value === 'READ_ONLY' || value === 'READ_WRITE' || value === 'SMART' || value === 'PROXY' || value === 'FULL') {
    return value;
  }
  return 'READ_ONLY';
}
