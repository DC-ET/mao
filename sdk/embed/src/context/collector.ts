/**
 * 上下文采集（设计文档 4.4）：
 * - context() 结果 JSON 序列化 + hash 变更检测，变化才拼引用块
 * - 上限 8KB（UTF-8 字节），超限截断并附提示
 * - 选中文本由 selection.ts 采集，这里负责拼装
 */
import { CONTEXT_LIMIT_BYTES } from '../types';

export interface PageContextPayload {
  url: string;
  title: string;
  data: Record<string, unknown>;
  truncated: boolean;
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

  /**
   * 组装本次发送的上下文前缀；返回 null 表示无变化、无选中文本，不拼。
   * selection 独立于 hash 判断：每次有选中内容都拼。
   */
  async buildPrefix(selection: string | null): Promise<string | null> {
    const payload = await this.collect();
    const parts: string[] = [];

    if (payload) {
      const serialized = stableStringify(payload.data);
      const h = hashString(serialized);
      if (h !== this.lastHash) {
        this.lastHash = h;
        const dataJson = payload.truncated
          ? truncateByBytes(serialized, CONTEXT_LIMIT_BYTES - 512) + '…(已截断)'
          : serialized;
        parts.push(
          [
            '[页面上下文]',
            `url: ${payload.url}`,
            `title: ${payload.title}`,
            `data: ${dataJson}`,
          ].join('\n'),
        );
      }
    }

    if (selection && selection.trim()) {
      parts.push(`[用户选中文本]\n${truncateByBytes(selection.trim(), CONTEXT_LIMIT_BYTES / 2)}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
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
    const serializedFull = stableStringify(full);
    return {
      url: full.url,
      title: full.title,
      data,
      truncated: utf8ByteLength(serializedFull) > CONTEXT_LIMIT_BYTES,
    };
  }
}
