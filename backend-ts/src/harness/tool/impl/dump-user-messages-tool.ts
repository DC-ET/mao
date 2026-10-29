import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseTool } from '../tool.js';
import { asIntStrict, asText, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { LocalToolExecutor } from '../../local/local-tool-executor.js';
import type { RuntimeDataResolver } from '../../runtime/runtime-data-resolver.js';
import type { Message, SessionMapper, SessionService } from '../../deps.js';

/** recentCount 缺省值：默认只导出最近一条用户消息。 */
const DEFAULT_RECENT_COUNT = 1;
/** recentCount 上限：单次最多导出的用户消息条数。 */
const MAX_RECENT_COUNT = 10;
/** 用户消息没有文本内容（如纯图片消息）时的占位内容，避免产出 0 字节文件。 */
const EMPTY_TEXT_PLACEHOLDER = '[本条用户消息不含文本内容]';

interface DumpFileEntry {
  messageId: number;
  path?: string;
  bytes?: number;
  error?: string;
}

function errorJson(message: string): string {
  return toJson({ error: message });
}

/**
 * 把本会话最近 N 条用户消息的原文落成文件（技术方案 2026-10-29）。
 *
 * 用户消息里的大批量精确数据（如 1000+ 个用户 ID）不适合让模型复述：漏位/错位/
 * 压缩丢精度都会让结果失真。本工具把原文变成可精确检索的文件，Agent 用
 * read_file（分页）/ grep_search / shell 处理，全程不复述数据。
 *
 * 执行模式归属：进 SERVER_ONLY_TOOLS（两种模式下服务端都是入口，负责读消息与决定落点）；
 * LOCAL 会话的文件写入经 WS 委托桌面端 `write_local_text_file` 落到本机
 * `~/.mao/attachments/{host}/{sessionId}/`，回传本机绝对路径。
 */
export class DumpUserMessagesTool extends BaseTool {
  constructor(
    private readonly sessionService: SessionService,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly localToolExecutor: LocalToolExecutor,
    private readonly sessionMapper: SessionMapper,
  ) { super(); }

  getName(): string { return 'dump_user_messages'; }
  getDescription(): string {
    return '把本会话最近 N 条用户消息的原文落成文件，返回文件的绝对路径数组。'
      + '当用户消息包含大批量精确数据（如成百上千个 ID/编码/清单），需要基于原文精确处理时使用：'
      + '拿到文件路径后用 read_file（支持 offset/limit 分页）/ grep_search / shell 处理，避免在回复或工具参数中复述原文。';
  }
  getToolPrompt(): string | null {
    return `## dump_user_messages 工具使用指南

- 用途：把「本会话最近 N 条用户消息」的原文写成文件，返回文件绝对路径。
- 适用场景：用户消息里包含大批量精确数据（典型：1000+ 个用户 ID 这类长数字清单）。
  这类数据不要用自己的输出复述（写文件、拼命令时手抄几十~上千个 ID 极易漏位/错位），
  也不要期望压缩后的摘要保留精度；先调用本工具拿到文件，再用 read_file
  （支持 offset/limit 分页）/ grep_search / shell 脚本精确处理，全程不复述原文。
- 参数只有 recentCount（整数，默认 1，最大 10）：对最近 N 条用户消息分别生成
  N 个独立文件，文件名形如 user-message-{消息id}.txt；同一消息重复导出会覆盖
  同一文件（按消息 id 幂等），不会产生重复副本。
- 工具不会从上下文移除原始消息，只是额外提供一份可精确检索的文件副本；
  文件内容是用户消息原文。
- 返回 JSON：files 数组（每项含 messageId / path / bytes；单条失败时为 messageId / error），
  count 为文件条数，message 为处理指引。LOCAL 会话中文件落在本机
  ~/.mao/attachments/ 目录下，返回的是本机绝对路径。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        recentCount: {
          type: 'integer',
          description: '要导出的最近用户消息条数：默认 1（最近一条），最大 10',
        },
      },
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: '每条用户消息一个条目：成功时为 {messageId, path, bytes}，失败时为 {messageId, error}',
          items: {
            type: 'object',
            properties: {
              messageId: { type: 'integer' },
              path: { type: 'string', description: '消息原文文件的绝对路径（成功时）' },
              bytes: { type: 'integer', description: '文件字节数（成功时）' },
              error: { type: 'string', description: '该条写入失败的原因（失败时）' },
            },
          },
        },
        count: { type: 'integer', description: 'files 数组条数' },
        message: { type: 'string', description: '处理指引：用文件工具链处理，不要复述原文' },
      },
    };
  }

  protected async executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    _workspace: string | null,
  ): Promise<string> {
    const args = parseObject(argumentsJson) ?? {};
    let recentCount = asIntStrict(args.recentCount, DEFAULT_RECENT_COUNT);
    if (recentCount < 1) recentCount = 1;
    if (recentCount > MAX_RECENT_COUNT) recentCount = MAX_RECENT_COUNT;

    if (sessionId == null) return errorJson('缺少会话上下文，无法定位用户消息');
    if (this.sessionService.getRecentUserMessages == null) {
      return errorJson('当前运行环境不支持读取用户消息');
    }

    let messages: Message[];
    try {
      messages = await this.sessionService.getRecentUserMessages(sessionId, recentCount);
    } catch (e) {
      harnessLog('error', `dump_user_messages failed to load messages: sessionId=${sessionId}`, e);
      return errorJson('读取用户消息失败：' + (e as Error).message);
    }
    if (messages.length === 0) return errorJson('本会话暂无用户消息');

    let isLocal = false;
    try {
      const session = await this.sessionMapper.selectById(sessionId);
      isLocal = session?.executionMode === 'LOCAL';
    } catch (e) {
      harnessLog('warn', `dump_user_messages failed to probe execution mode: sessionId=${sessionId}`, e);
    }

    const files: DumpFileEntry[] = isLocal
      ? await this.writeViaLocalDesktop(sessionId, messages)
      : this.writeToRuntime(userId, sessionId, messages);
    return buildResult(files);
  }

  /** CLOUD：直接写服务端 runtime 目录（会话运行目录，Agent 的 read_file / grep_search 可达）。 */
  private writeToRuntime(userId: number | null, sessionId: number, messages: Message[]): DumpFileEntry[] {
    if (userId == null) {
      return messages.map((message) => ({
        messageId: message.id ?? 0,
        error: '缺少用户上下文，无法定位消息文件目录',
      }));
    }
    const dir = this.runtimeDataResolver.resolveUserMessagesDir(userId, sessionId);
    const files: DumpFileEntry[] = [];
    for (const message of messages) {
      if (message.id == null) {
        files.push({ messageId: 0, error: '消息缺少 id，无法命名文件' });
        continue;
      }
      const content = this.resolveMessageText(message);
      const filePath = join(dir, `user-message-${message.id}.txt`);
      try {
        mkdirSync(dir, { recursive: true });
        // 以消息 id 为文件名：重复调用覆盖同一文件，幂等。
        writeFileSync(filePath, content, 'utf8');
        files.push({ messageId: message.id, path: filePath, bytes: Buffer.byteLength(content, 'utf8') });
      } catch (e) {
        harnessLog('warn', `dump_user_messages failed to write file: ${filePath}`, e);
        files.push({ messageId: message.id, error: '写入失败：' + (e as Error).message });
      }
    }
    return files;
  }

  /**
   * LOCAL：委托桌面端 `write_local_text_file` 写入本机 ~/.mao/attachments/ 目录，
   * 回传本机绝对路径。单条失败（桌面端未连接 / 文件名非法 / 写盘失败）不影响其余条目。
   */
  private async writeViaLocalDesktop(sessionId: number, messages: Message[]): Promise<DumpFileEntry[]> {
    const files: DumpFileEntry[] = [];
    for (const message of messages) {
      if (message.id == null) {
        files.push({ messageId: 0, error: '消息缺少 id，无法命名文件' });
        continue;
      }
      const content = this.resolveMessageText(message);
      const fileName = `user-message-${message.id}.txt`;
      try {
        const raw = await this.localToolExecutor.execute(
          sessionId, 'write_local_text_file', JSON.stringify({ fileName, content }), null, false, null,
        );
        const parsed = parseObject(raw);
        const path = parsed != null ? asText(parsed.path) : null;
        if (path != null && path !== '') {
          files.push({ messageId: message.id, path, bytes: Buffer.byteLength(content, 'utf8') });
        } else {
          const error = parsed != null ? asText(parsed.error) : null;
          files.push({ messageId: message.id, error: error ?? '本地写入失败' });
        }
      } catch (e) {
        harnessLog('warn', `dump_user_messages local write failed: messageId=${message.id}`, e);
        files.push({ messageId: message.id, error: '本地写入失败：' + (e as Error).message });
      }
    }
    return files;
  }

  /** 用户消息可见文本：多模态消息取文本部分（与检索片段同口径），无文本时给占位说明。 */
  private resolveMessageText(message: Message): string {
    const visible = this.sessionService.extractVisibleText?.(message.content ?? null) ?? message.content ?? '';
    return visible.trim() === '' ? EMPTY_TEXT_PLACEHOLDER : visible;
  }
}

function buildResult(files: DumpFileEntry[]): string {
  const ok = files.filter((file) => file.path != null);
  const failed = files.length - ok.length;
  const message = ok.length === 0
    ? `未能导出用户消息：全部 ${files.length} 条写入失败，详见 files 中的 error 字段。`
    : `已导出 ${ok.length} 条用户消息为文件。请用 read_file（支持 offset/limit 分页）、grep_search 或 shell 处理文件内容，`
      + '不要在回复或工具参数中复述文件原文。'
      + (failed > 0 ? `其中 ${failed} 条写入失败，详见 files 中的 error 字段。` : '');
  return toJson({ files, count: files.length, message });
}
