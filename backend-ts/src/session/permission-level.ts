export type PermissionLevel = 'READ_ONLY' | 'READ_WRITE' | 'SMART' | 'PROXY' | 'FULL';

const VALUES: PermissionLevel[] = ['READ_ONLY', 'READ_WRITE', 'SMART', 'PROXY', 'FULL'];

export function fromString(value: string | null | undefined): PermissionLevel {
  if (value == null) {
    return 'READ_ONLY';
  }
  return VALUES.includes(value as PermissionLevel) ? (value as PermissionLevel) : 'READ_ONLY';
}

export const PermissionLevelEnum = { fromString, VALUES };
