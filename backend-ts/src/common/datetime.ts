/**
 * Mimic Java LocalDateTime.toString() (ISO-8601, omit zero seconds/nanos).
 * MySQL dateStrings typically arrive as `yyyy-MM-dd HH:mm:ss`.
 */
export function javaLocalDateTimeString(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    const y = value.getFullYear();
    const mo = pad(value.getMonth() + 1);
    const d = pad(value.getDate());
    const h = pad(value.getHours());
    const mi = pad(value.getMinutes());
    const s = value.getSeconds();
    const n = value.getMilliseconds();
    let out = `${y}-${mo}-${d}T${h}:${mi}`;
    if (s !== 0 || n !== 0) {
      out += `:${pad(s)}`;
      if (n !== 0) {
        out += `.${String(n * 1_000_000).padStart(9, '0').replace(/0+$/, '')}`;
      }
    }
    return out;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/);
  if (!m) {
    return raw.includes('T') ? raw : raw.replace(' ', 'T');
  }
  const sec = m[4] ?? '00';
  const frac = m[5];
  let out = `${m[1]}T${m[2]}:${m[3]}`;
  if (sec !== '00' || frac) {
    out += `:${sec}`;
    if (frac && Number(frac) !== 0) {
      out += `.${frac.replace(/0+$/, '')}`;
    }
  }
  return out;
}

export function nowSql(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
