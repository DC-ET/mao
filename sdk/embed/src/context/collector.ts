/**
 * 上下文采集（设计文档 4.4）：
 * - context() 结果 + url/title 一起 hash 做变更检测，变化才拼引用块
 * - 拼装后的总前缀统一受 8KB（UTF-8 字节）上限约束，超限截断并附提示
 * - 选中文本由 selection.ts 采集，这里负责拼装
 */
import { CONTEXT_LIMIT_BYTES } from '../types';

/** 截断提示后缀：附在被截断内容末尾 */
const TRUNCATED_SUFFIX = '…(已截断)';
/** 上下文块标头：拼装与还原（历史回显）共用 */
const CONTEXT_HEADER = '[页面上下文]';
const SELECTION_HEADER = '[用户选中文本]';
/** 上下文前缀与用户正文之间的分隔符 */
export const PREFIX_SEPARATOR = '\n\n---\n\n';

export interface PageContextPayload {
  url: string;
  title: string;
  data: Record<string, unknown>;
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 按字节截断（不切断多字节字符），保证 <= limit；按码点线性累积，避免 O(n²) */
export function truncateByBytes(s: string, limit: number): string {
  if (utf8ByteLength(s) <= limit) return s;
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const len = utf8ByteLength(ch);
    if (bytes + len > limit) break;
    bytes += len;
    end += ch.length;
  }
  return s.slice(0, end);
}

/** 稳定序列化：键排序，避免同一对象不同键序被误判为“变化” */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hashString(s: string): string {
  // FNV-1a 32bit：上下文变更检测足够，无碰撞安全要求
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * 剥掉发送时拼在正文前的上下文/选中引用块，还原用户真正输入的文本。
 * 历史消息从服务端取回的是拼装后的完整内容，直接上屏会让用户看到一整坨
 * `[页面上下文] url:… data:{…}` JSON（乐观气泡显示的是纯输入，两者必须一致）。
 */
export function stripContextPrefix(content: string): string {
  if (!content.startsWith(CONTEXT_HEADER) && !content.startsWith(SELECTION_HEADER)) return content;
  const idx = content.indexOf(PREFIX_SEPARATOR);
  // 只有前缀没有正文（理论上不会发生：send() 要求 content 非空）时保留原文，不返回空气泡
  if (idx < 0) return content;
  return content.slice(idx + PREFIX_SEPARATOR.length);
}

export class ContextCollector {
  private lastHash: string | null = null;
  /** 宿主通过 chat.setContext() 命令式覆盖的上下文 */
  private overrideContext: Record<string, unknown> | null = null;

  constructor(private readonly supplier?: () => Record<string, unknown> | Promise<Record<string, unknown>>) {}

  setOverride(ctx: Record<string, unknown> | null) {
    this.overrideContext = ctx;
    // 命令式覆盖立即失效缓存，下次发送必然重新评估
    this.lastHash = null;
  }

  /** 取当前变更检测基线：发送失败时配合 restoreHash 回滚，避免重发丢失上下文 */
  snapshotHash(): string | null {
    return this.lastHash;
  }

  /** 回滚变更检测基线（发送失败时调用），使下次发送重新携带同一份上下文 */
  restoreHash(hash: string | null) {
    this.lastHash = hash;
  }

  /**
   * 组装本次发送的上下文前缀；返回 null 表示无变化、无选中文本，不拼。
   * selection 独立于 hash 判断：每次有选中内容都拼。
   * 总长度（含两个块与分隔符）统一受 CONTEXT_LIMIT_BYTES 约束。
   */
  async buildPrefix(selection: string | null): Promise<string | null> {
    const payload = await this.collect();
    const sel = selection && selection.trim() ? selection.trim() : null;
    const parts: string[] = [];
    // 选中文本是用户显式指定的，先保底一半预算；剩余额度全部留给页面上下文
    const selBudget = sel ? Math.min(utf8ByteLength(sel), Math.floor(CONTEXT_LIMIT_BYTES / 2)) : 0;

    if (payload) {
      // hash 覆盖 {url,title,data} 整体：SPA 路由切换后 data 不变也要重新注入新 url
      const fingerprint = stableStringify({ url: payload.url, title: payload.title, data: payload.data });
      const h = hashString(fingerprint);
      if (h !== this.lastHash) {
        this.lastHash = h;
        const header = `${CONTEXT_HEADER}\nurl: ${payload.url}\ntitle: ${payload.title}\ndata: `;
        const serialized = stableStringify(payload.data);
        const dataBudget =
          CONTEXT_LIMIT_BYTES -
          selBudget -
          utf8ByteLength(header) -
          utf8ByteLength(TRUNCATED_SUFFIX) -
          // 块间分隔符 '\n\n' 与选中块标头的余量
          64;
        const dataJson =
          dataBudget > 0 && utf8ByteLength(serialized) <= dataBudget
            ? serialized
            : truncateByBytes(serialized, Math.max(dataBudget, 0)) + TRUNCATED_SUFFIX;
        parts.push(header + dataJson);
      }
    }

    if (sel) {
      const kept = truncateByBytes(sel, selBudget);
      parts.push(`${SELECTION_HEADER}\n${kept}${kept.length < sel.length ? TRUNCATED_SUFFIX : ''}`);
    }

    if (parts.length === 0) return null;
    const joined = parts.join('\n\n');
    // 兜底硬上限：标头累计仍可能超出预算时整体截断
    if (utf8ByteLength(joined) <= CONTEXT_LIMIT_BYTES) return joined;
    return (
      truncateByBytes(joined, CONTEXT_LIMIT_BYTES - utf8ByteLength(TRUNCATED_SUFFIX)) + TRUNCATED_SUFFIX
    );
  }

  private async collect(): Promise<PageContextPayload | null> {
    let data: Record<string, unknown>;
    if (this.overrideContext) {
      data = this.overrideContext;
    } else if (this.supplier) {
      try {
        const resolved = await this.supplier();
        data = resolved ?? {};
      } catch {
        // 宿主 context() 抛错不阻断发送：退化为仅 url/title
        data = {};
      }
    } else {
      return null;
    }
    const full = { url: window.location.href, title: document.title, data };
    return { url: full.url, title: full.title, data };
  }
}
