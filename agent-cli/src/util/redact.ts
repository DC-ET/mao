const SENSITIVE_KEYS = [
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'password',
];

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+=/]+/gi;

export function redactString(value: string): string {
  return value
    .replace(JWT_RE, '***')
    .replace(BEARER_RE, 'Bearer ***');
}

export function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.includes(k.toLowerCase())) {
        out[k] = v == null || v === '' ? v : '***';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

export function redactJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return '[unserializable]';
  }
}

/** 从模型列表中立刻丢掉明文 apiKey，禁止进入后续处理。 */
export function stripModelSecrets<T extends { apiKey?: string }>(models: T[]): Omit<T, 'apiKey'>[] {
  return models.map((m) => {
    const { apiKey: _drop, ...rest } = m;
    return rest;
  });
}
