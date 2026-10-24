export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function asText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

/**
 * 严格整数解析：只接受「本身就是整数」的 number 或纯整数字符串。
 * 与 asInt 的区别是不做 Math.trunc——小数/负小数必须落 fallback，否则
 * `asInt(1.9)` 会被当成 1、`asInt(-0.5)` 会得到 -0 并绕过 `n < 0` 校验。
 */
export function asIntStrict(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?\d+$/.test(text)) {
      const n = Number(text);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return fallback;
}

export function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  }
  return fallback;
}

export function errorJson(message: string): string {
  return toJson({ error: message });
}
