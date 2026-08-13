export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function toCamel<T>(row: Record<string, unknown> | null | undefined): T | null {
  if (!row) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out as T;
}

export function toCamelList<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => toCamel<T>(row) as T);
}

export function toSnakeRow(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      out[camelToSnake(k)] = v;
    }
  }
  return out;
}

export function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}
