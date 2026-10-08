import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../deps.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { harnessLog } from '../log.js';
import { toMessageJsonlLine } from '../../session/message-jsonl.js';

/** 会话压缩成功后，将本次被压缩区间的原始消息按批次归档为 JSONL 文件（仅 CLOUD 模式）。 */
export class CompactionArchiveService {
  constructor(private readonly runtimeDataResolver: RuntimeDataResolver) {}

  resolveDir(userId: number, sessionId: number): string {
    return this.runtimeDataResolver.resolveCompactionDir(userId, sessionId);
  }

  /**
   * 将 (上一边界, 本次边界] 区间的消息写入归档文件 compaction-NNN.jsonl（NNN = DB compact_count）。
   * LOCAL 模式直接跳过；写失败仅告警，不阻断压缩主流程。
   */
  writeArchive(
    executionMode: string | null | undefined,
    userId: number | null | undefined,
    sessionId: number | null | undefined,
    seq: number,
    messages: Message[],
  ): void {
    if (this.isLocal(executionMode) || userId == null || sessionId == null) return;
    if (messages.length === 0) return;
    try {
      const dir = this.resolveDir(userId, sessionId);
      mkdirSync(dir, { recursive: true });
      const fileName = `compaction-${String(seq).padStart(3, '0')}.jsonl`;
      const finalPath = join(dir, fileName);
      const tmpPath = finalPath + '.tmp';
      const body = messages.map((m) => JSON.stringify(toMessageJsonlLine(m))).join('\n') + '\n';
      writeFileSync(tmpPath, body, 'utf8');
      renameSync(tmpPath, finalPath);
    } catch (e) {
      harnessLog('warn', `Failed to write compaction archive: sessionId=${sessionId}, seq=${seq}`, e);
    }
  }

  /** 归档目录下已存在的归档文件名列表（升序），目录不存在或为空返回空数组。 */
  listArchiveFiles(userId: number, sessionId: number): string[] {
    const dir = this.resolveDir(userId, sessionId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((name) => name.startsWith('compaction-') && name.endsWith('.jsonl'))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 构建注入交接消息末尾的归档指引；不满足注入条件（LOCAL / 缺少 uid/sid / 无归档文件）时返回 null。
   */
  buildArchiveHint(
    executionMode: string | null | undefined,
    userId: number | null | undefined,
    sessionId: number | null | undefined,
  ): string | null {
    if (this.isLocal(executionMode) || userId == null || sessionId == null) return null;
    if (this.listArchiveFiles(userId, sessionId).length === 0) return null;
    return [
      '## 已压缩历史消息归档',
      '',
      '此前被压缩的全部会话消息已按压缩批次归档为 JSONL 文件，目录：`' + this.resolveDir(userId, sessionId) + '`。',
      '- 文件命名：compaction-NNN.jsonl（NNN 为压缩序号，序号越大越新）；每个文件包含该次压缩区间内的全部原始消息。',
      '- 每行一个 JSON 对象，字段：id、role、content、toolCallId、toolCalls、metadata、tokenCount、modelId、createdAt（不含 thinkingContent）；'
        + '内联图片 base64 已替换为占位符，原图路径见 metadata 内 attachments 的 path 字段（通常为工作区相对路径）。',
      '',
      '当本交接内容缺少你需要的细节（历史用户原话、文件路径、命令输出、错误信息、已确认决策依据等）时，'
        + '用 read_file（支持 offset/limit 分页）、grep_search 或 shell 工具检索上述目录回读原始消息，不要凭摘要猜测或臆造细节。',
    ].join('\n');
  }

  private isLocal(executionMode: string | null | undefined): boolean {
    return executionMode?.toUpperCase() === 'LOCAL';
  }
}
