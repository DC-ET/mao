/**
 * IM 渠道控制命令的共享解析器（技术方案 2026-11-22「IM 渠道控制命令补完」D1/D8）。
 *
 * 三渠道（飞书 / 钉钉 / 微信）入站 handler 各自调用同一份纯函数，保证命令语义不漂移：
 * - trim 后**全等匹配**（大小写敏感，与既有群 `/new` 口径一致）；
 * - `/tasks <n>` 允许命令与序号间任意空白（含全角空格，`\s` 覆盖 U+3000），序号限 1-9；
 * - 不命中返回 NONE——调用方逐字节走原链路，本解析器对未命中路径零影响。
 *
 * 群聊场景由调用方先剥掉 @ 机器人名（飞书 `groupCommandTextOf` / 钉钉 `cleanText`）再传入；
 * `@机器人 你好 /stop` 这类剥名后不等于命令的文本不命中，照常走 Agent。
 */
export type ChannelCommand =
  | { kind: 'NEW' }
  | { kind: 'STOP' }
  | { kind: 'TASKS' }
  | { kind: 'TASKS_SELECT'; index: number }
  | { kind: 'HELP' }
  | { kind: 'NONE' };

/** `/tasks <n>`：n 为 1-9 单个数字（列表固定 LIMIT 5，一位数字够用且防止 `/tasks 10` 类误伤）。 */
const TASKS_SELECT_PATTERN = /^\/tasks\s+([1-9])$/;

export function parseChannelCommand(text: string | null | undefined): ChannelCommand {
  const trimmed = (text ?? '').trim();
  if (trimmed === '/new') return { kind: 'NEW' };
  if (trimmed === '/stop') return { kind: 'STOP' };
  if (trimmed === '/tasks') return { kind: 'TASKS' };
  if (trimmed === '/help') return { kind: 'HELP' };
  const select = TASKS_SELECT_PATTERN.exec(trimmed);
  if (select != null) return { kind: 'TASKS_SELECT', index: Number(select[1]) };
  return { kind: 'NONE' };
}

// ─── /tasks 列表渲染（三渠道共用一份，防文案漂移；技术方案 §4.6 文案表） ───────────

/** 标题超长按码点截断（防 emoji 被切成半个代理对），截断后不再加省略号（与钉钉标题口径一致）。 */
export function truncateChannelTitle(title: string, maxChars = 20): string {
  const codePoints = Array.from(title);
  return codePoints.length > maxChars ? codePoints.slice(0, maxChars).join('') : title;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过 7 天显示日期。
 * DB DATETIME 经 dateStrings 取出为上海墙钟字符串（连接池 timezone=+08:00），
 * 解析时显式补 +08:00，避免宿主时区不是上海时整体漂移。
 */
export function formatChannelRelativeTime(updatedAt: string | null | undefined, now: Date = new Date()): string {
  if (updatedAt == null || updatedAt.trim() === '') return '时间未知';
  const normalized = updatedAt.includes('T') ? updatedAt : updatedAt.replace(' ', 'T');
  const parsed = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`);
  if (Number.isNaN(parsed.getTime())) return '时间未知';
  const diffMs = Math.max(0, now.getTime() - parsed.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  // 输入本身就是上海墙钟字符串，直接取日期部分——toISOString 会转 UTC，跨零点时刻会显示成前一天。
  const datePart = /^(\d{4}-\d{2}-\d{2})/.exec(updatedAt.trim());
  return datePart?.[1] ?? parsed.toISOString().slice(0, 10);
}

/** 渠道简报最小形状（session.repository 的 ChannelSessionBrief 结构子集），避免 common 反向依赖 session。 */
export interface ChannelSessionBriefLike {
  title: string | null;
  phase: string | null;
  updatedAt: string | null;
}

/** `/tasks` 列表正文：`1. 标题（进行中）· 5 分钟前` 多行 + 尾行切换提示；空列表返回空串由调用方另行提示。 */
export function renderChannelSessionList(briefs: ChannelSessionBriefLike[], isActivePhase: (phase: string | null | undefined) => boolean, now: Date = new Date()): string {
  const lines = briefs.map((brief, i) => {
    const title = truncateChannelTitle((brief.title ?? '').trim() === '' ? '未命名会话' : brief.title!);
    const badge = isActivePhase(brief.phase) ? '（进行中）' : '';
    return `${i + 1}. ${title}${badge} · ${formatChannelRelativeTime(brief.updatedAt, now)}`;
  });
  lines.push('回复 /tasks <序号> 切换，如 /tasks 2');
  return lines.join('\n');
}
