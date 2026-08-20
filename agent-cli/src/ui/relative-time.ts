const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const delta = Math.max(0, now - ts);
  if (delta < 15_000) return '刚刚';
  if (delta < MIN) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < HOUR) return `${Math.floor(delta / MIN)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} 天前`;
  return iso.replace('T', ' ').slice(0, 16);
}
