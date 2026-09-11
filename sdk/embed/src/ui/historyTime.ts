/**
 * 历史列表相对时间：分钟内=刚刚/N 分钟前，当天=HH:mm，7 天内=昨天/N 天前，更早=YYYY-MM-DD。
 * 服务端返回 `YYYY-MM-DD HH:mm:ss`（javaLocalDateTimeString，服务器本地时区），空格形式补 T 后按浏览器时区解析。
 */
export function formatRelativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const ts = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T')).getTime();
  if (Number.isNaN(ts)) return '';
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return '';
  const MIN = 60_000;
  if (diffMs < MIN) return '刚刚';
  if (diffMs < 60 * MIN) return `${Math.floor(diffMs / MIN)} 分钟前`;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(new Date(ts))) / 86_400_000);
  if (dayDiff === 0) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (dayDiff === 1) return '昨天';
  if (dayDiff < 7) return `${dayDiff} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
