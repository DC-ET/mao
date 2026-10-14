import { createHash } from 'node:crypto';
import { hasText } from '../../common/case.js';
import { harnessLog } from '../log.js';
import type { SessionWorkspaceRulesRow, WorkspaceRulesSnapshotRepository } from './workspace-rules-snapshot.repository.js';

/**
 * 规则文本来源：CLOUD 为 AGENTS.md 绝对路径与 mtime；LOCAL 内容由桌面端上报，服务端
 * 看不到文件，两者皆为 null。
 */
export interface WorkspaceRulesSource {
  sourcePath: string | null;
  sourceMtime: number | null;
}

/** 与 prompt-prefix-monitor 同口径的 sha256，保证排障时两侧 hash 可直接对比。 */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 「磁盘已变」日志去重表上限，与 prompt-prefix-monitor 的 MAX_SESSIONS 对齐。 */
const MAX_LOGGED_SESSIONS = 512;

/** 去重表里标记「本会话已打过空读日志」的哨兵值（hashText 产物恒为 64 位 hex，不会冲突）。 */
const EMPTY_MARKER = '';

/**
 * 会话级工作区规则快照（技术方案 2026-10-14 §4.2/§4.4）。
 *
 * 把「工作区规则」这一节的文本在会话维度冻结：会话内编辑 AGENTS.md 只对新会话生效，
 * 消除"改一次 AGENTS.md 打掉全局前缀"的高频失效。快照落库，后端重启/蓝绿切换后
 * 仍沿用同一文本。
 */
export class WorkspaceRulesSnapshotService {
  /** 同一 disk_hash 每会话只打一次「磁盘已变」日志，避免每轮刷屏；重启即失忆无副作用。 */
  private readonly loggedDiskHashes = new Map<number, string>();

  constructor(private readonly repo: WorkspaceRulesSnapshotRepository) {}

  /**
   * 取本次请求应注入的规则文本。
   *
   * - 命中且 workspace 一致 → 用快照文本（即使磁盘已变、甚至已空也不摘节）
   * - 未命中 / workspace 不一致 / 快照行为异常空值 → 用本次读盘内容覆盖写回
   * - 未命中且读盘为空 → 不落库、不注入该节（否则"会话早于规则文件创建"的会话永远看不到规则）
   */
  async resolve(
    sessionId: number,
    workspace: string,
    rawText: string,
    source: WorkspaceRulesSource,
  ): Promise<string> {
    const existing = await this.repo.selectBySessionId(sessionId);
    if (existing != null && existing.workspace === workspace && hasText(existing.rulesText)) {
      this.logRetained(sessionId, existing, rawText);
      return existing.rulesText;
    }
    if (!hasText(rawText)) {
      // 走到这里 existing 只可能是无效行（workspace 不一致 / rules_text 异常空）：
      // 既不改写也不删除会让它一直残留到会话删除，故顺手回收（评审 round 1 BUG-2）。
      if (existing != null) await this.repo.deleteBySessionId(sessionId);
      return '';
    }
    const rulesHash = hashText(rawText);
    await this.repo.upsert({
      sessionId,
      workspace,
      rulesText: rawText,
      rulesHash,
      sourcePath: source.sourcePath,
      sourceMtime: source.sourceMtime,
    });
    harnessLog('info', `workspace rules snapshot pinned session=${sessionId} chars=${rawText.length}`
      + ` source=${source.sourcePath ?? 'local-reported'} mtime=${source.sourceMtime ?? '-'}`);
    return rawText;
  }

  /** 压缩提交成功后解冻：下一轮重新读盘并落库，让新规则在本会话尽快生效。 */
  async invalidate(sessionId: number): Promise<void> {
    const deleted = await this.repo.deleteBySessionId(sessionId);
    this.loggedDiskHashes.delete(sessionId);
    if (deleted > 0) {
      harnessLog('info', `workspace rules snapshot invalidated session=${sessionId} reason=compaction-committed`);
    }
  }

  /** 会话删除 / 边路会话提升时物理删行。 */
  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.repo.deleteBySessionId(sessionId);
    this.loggedDiskHashes.delete(sessionId);
  }

  /** 仅测试使用：清空日志去重状态。 */
  resetForTest(): void {
    this.loggedDiskHashes.clear();
  }

  private logRetained(sessionId: number, existing: SessionWorkspaceRulesRow, rawText: string): void {
    if (!hasText(rawText)) {
      // 空读（LOCAL 桌面端漏报 / 文件被删空）也必须按会话去重：后端重启后 LOCAL 登记表清空，
      // 信号/定时任务触发的轮次没有桌面端上报，会连续命中，每轮一条 info 会淹没真正的
      // pinned / invalidated 行（评审 round 1 BUG-3）。'' 作哨兵——hashText 产物恒为
      // 64 位 hex，不会与真实 disk_hash 冲突。
      if (this.loggedDiskHashes.get(sessionId) === EMPTY_MARKER) return;
      this.touchLogged(sessionId, EMPTY_MARKER);
      harnessLog('info', `workspace rules empty on disk but snapshot retained session=${sessionId} effective=on-next-snapshot`);
      return;
    }
    const diskHash = hashText(rawText);
    if (diskHash === existing.rulesHash) return;
    if (this.loggedDiskHashes.get(sessionId) === diskHash) return;
    this.touchLogged(sessionId, diskHash);
    harnessLog('info', `workspace rules changed on disk but snapshot retained session=${sessionId}`
      + ` disk_hash=${diskHash.slice(0, 8)}… pinned_hash=${existing.rulesHash.slice(0, 8)}… effective=on-next-snapshot`);
  }

  private touchLogged(sessionId: number, marker: string): void {
    // 去重表按插入序淘汰（Map.set 不会把已存在的键移到末尾，故这里是 FIFO 而非严格 LRU）：
    // 超限时删最早写入的那个。被淘汰只意味着该会话下次可能多打一条 info 日志，不影响功能。
    // 键已存在时 set 不增长 size，不必淘汰。
    if (this.loggedDiskHashes.size >= MAX_LOGGED_SESSIONS && !this.loggedDiskHashes.has(sessionId)) {
      const oldest = this.loggedDiskHashes.keys().next();
      if (!oldest.done) this.loggedDiskHashes.delete(oldest.value);
    }
    this.loggedDiskHashes.set(sessionId, marker);
  }
}
