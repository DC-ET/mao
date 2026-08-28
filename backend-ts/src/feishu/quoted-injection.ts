import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 引用消息内联长度阈值：超出部分不进上下文，全文落盘供 Agent 按需读取。 */
const INLINE_LIMIT = 100;
/** 落盘失败时的降级内联截断长度（防超长引用撑爆用户消息）。 */
const FALLBACK_LIMIT = 1500;

export interface QuotedInjectionTarget {
  /** 被引用消息 id（om_xxx），作为落盘文件名的一部分。 */
  parentMessageId: string;
  /** 会话工作区绝对路径；null 表示无法定位工作区（降级为纯截断）。 */
  workspace: string | null;
}

/** 引用消息注入文本：超过 100 字仅保留前缀，全文写入会话工作区 quoted/ 目录，
 *  以 @{路径}@ 引用提示 Agent 按需读取；落盘失败降级为 1500 字截断，不阻塞触发链路。 */
export async function buildQuotedInjection(text: string, target: QuotedInjectionTarget): Promise<string> {
  if (text.length <= INLINE_LIMIT) return text;
  const path = target.workspace != null ? await writeQuotedFile(target.workspace, target.parentMessageId, text) : null;
  if (path != null) {
    return `${text.slice(0, INLINE_LIMIT)}…（引用内容过长已截断，全文见文件 @{${path}}@）`;
  }
  return `${text.slice(0, FALLBACK_LIMIT)}…（引用内容过长已截断）`;
}

async function writeQuotedFile(workspace: string, parentMessageId: string, content: string): Promise<string | null> {
  try {
    const dir = join(workspace, 'quoted');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `quoted-${parentMessageId}.txt`);
    await writeFile(path, content, 'utf8');
    return path;
  } catch (error) {
    console.warn(`引用消息全文落盘失败, parentMessageId=${parentMessageId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
