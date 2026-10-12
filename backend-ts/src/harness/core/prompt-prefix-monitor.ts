import { createHash } from 'node:crypto';
import { harnessLog } from '../log.js';
import type { ToolDefinition } from '../llm/chat-request.js';

/**
 * 前缀指纹观测（技术方案 2026-10-12 §4.3）。
 *
 * 把「请求前缀是否稳定」从黑盒变成可运维对象：每次 buildRequest 时比对系统提示逐节
 * hash 与工具定义 hash，变化时打 warn 并点名是哪几节变了。前缀位于缓存层级最前，
 * system / tools 任一变化都会让该轮及之后全部 miss，无归因手段时缓存回归只能靠猜。
 *
 * 存储选进程内存：指纹只在「同一会话相邻两次请求」的比较中有意义，重启后第一次请求
 * 重新登记即可；多实例部署时同一会话落到不同实例会各记一份（顶多多一次「首次登记」，
 * 不产生错误结论）。Map 有上限，按插入序淘汰，避免长跑进程泄漏。
 */

/** 单个会话的前缀快照。 */
export interface PrefixSnapshot {
  /** 系统提示分节 key → sha256(text)。逐节 hash 才能在整串变化时归因到节。 */
  systemSections: Record<string, string>;
  /** 工具定义数组的 sha256（JSON.stringify 口径，跨轮要求字节一致）。 */
  toolsHash: string;
  /** 消息条数，仅用于日志上下文。口径由调用方决定（PromptEngine 传入排除 system 的历史条数）。 */
  messageCount: number;
  at: number;
}

/** 比对结果：供调用方（与测试）判断是否发生了前缀变化。 */
export interface PrefixObservation {
  changedSections: string[];
  toolsChanged: boolean;
  firstObservation: boolean;
}

const MAX_SESSIONS = 512;

const snapshots = new Map<number, PrefixSnapshot>();

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hashTools(tools: ToolDefinition[] | undefined): string {
  return hashText(JSON.stringify(tools ?? []));
}

function touch(sessionId: number, snapshot: PrefixSnapshot): void {
  // 重新 set 会把该键移到插入序末尾，超出上限时淘汰最旧的一个（LRU 简易实现）
  snapshots.delete(sessionId);
  snapshots.set(sessionId, snapshot);
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next();
    if (oldest.done) break;
    snapshots.delete(oldest.value);
  }
}

/**
 * 登记一次 buildRequest 的前缀指纹，与同会话上一次比对并打点。
 * @param sections 系统提示分节（key + text，来自 PromptEngine 的同一份 sections，所见即所发）
 * @param tools 最终请求携带的工具定义
 * @param messageCount 消息条数，仅日志上下文（口径由调用方决定）
 */
export function observePrefix(
  sessionId: number,
  sections: Array<{ key: string; text: string }>,
  tools: ToolDefinition[] | undefined,
  messageCount: number,
): PrefixObservation {
  const previous = snapshots.get(sessionId);
  const systemSections: Record<string, string> = {};
  for (const section of sections) {
    // 空节不产生 text（与 PromptEngine 的拼接口径一致），跳过与追加空串等价
    if (section.text.length === 0) continue;
    systemSections[section.key] = hashText(section.text);
  }
  const toolsHash = hashTools(tools);
  if (previous == null) {
    touch(sessionId, { systemSections, toolsHash, messageCount, at: Date.now() });
    harnessLog('info', `prefix fingerprint registered session=${sessionId} sections=${Object.keys(systemSections).length} tools=${tools?.length ?? 0} messages=${messageCount}`);
    return { changedSections: [], toolsChanged: false, firstObservation: true };
  }
  const changedSections: string[] = [];
  for (const [key, hash] of Object.entries(systemSections)) {
    if (previous.systemSections[key] !== hash) changedSections.push(key);
  }
  // 上一次有、这次没有的节同样算变化（节被移除也会打掉前缀）
  for (const key of Object.keys(previous.systemSections)) {
    if (!(key in systemSections)) changedSections.push(key);
  }
  const toolsChanged = previous.toolsHash !== toolsHash;
  touch(sessionId, { systemSections, toolsHash, messageCount, at: Date.now() });
  if (changedSections.length > 0 || toolsChanged) {
    harnessLog('warn', `prefix changed session=${sessionId} changedSections=[${changedSections.join(',')}]`
      + ` toolsChanged=${toolsChanged} messages=${messageCount}`);
  }
  return { changedSections, toolsChanged, firstObservation: false };
}

/** 会话结束时清理指纹，避免快照长期滞留（会话删除 / 执行结束路径调用）。 */
export function resetPrefixFingerprint(sessionId: number): void {
  snapshots.delete(sessionId);
}

/** 仅测试使用：清空全部指纹。 */
export function resetPrefixMonitorForTest(): void {
  snapshots.clear();
}
