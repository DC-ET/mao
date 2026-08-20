import type { CliEvent, Renderer, RunResult } from './types';

export interface JsonRendererOptions {
  stream: boolean;
  streamPartial: boolean;
  includeToolIo: boolean;
  stderr?: (s: string) => void;
  write?: (obj: unknown) => void;
}

/**
 * json：终态一次性输出。
 * stream-json：NDJSON；默认按 assistant 文本块聚合，--stream-partial-output 才逐 delta。
 * stdout 只允许 JSON；进度走 stderr。
 */
export class JsonRenderer implements Renderer {
  private currentText = '';
  private readonly write: (obj: unknown) => void;

  constructor(private readonly opts: JsonRendererOptions) {
    this.write = opts.write ?? ((obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n'));
  }

  onEvent(evt: CliEvent): void {
    if (!this.opts.stream) {
      if (evt.type === 'reconnected') this.opts.stderr?.('连接已恢复，可能丢失部分输出\n');
      return;
    }
    switch (evt.type) {
      case 'session_started':
        this.write({ type: 'system', subtype: 'session_started', sessionId: evt.sessionId, executionId: evt.executionId });
        break;
      case 'content_delta':
        this.currentText += evt.delta;
        if (this.opts.streamPartial) {
          this.write({ type: 'assistant', message: { content: [{ type: 'text', text: evt.delta }] } });
        }
        break;
      case 'tool_call_start':
        this.flushAssistant();
        this.write({
          type: 'tool_call',
          status: 'start',
          tool_call_id: evt.toolCallId,
          tool_name: evt.toolName,
          arguments: evt.arguments,
        });
        break;
      case 'tool_call_result':
        this.write({
          type: 'tool_call',
          status: 'result',
          tool_call_id: evt.toolCallId,
          tool_name: evt.toolName,
          result: this.opts.includeToolIo ? evt.result : undefined,
        });
        break;
      case 'llm_stream_reset':
        this.currentText = '';
        break;
      case 'reconnected':
        this.write({ type: 'system', subtype: 'reconnected' });
        break;
      case 'error':
        this.write({ type: 'error', message: evt.message });
        break;
      default:
        break;
    }
  }

  finish(result: RunResult): void {
    if (this.opts.stream) {
      this.flushAssistant();
      this.write({
        type: 'result',
        status: result.status,
        sessionId: result.sessionId,
        executionId: result.executionId,
        result: result.result,
        usage: result.usage,
        toolCalls: result.toolCalls,
        fileChanges: result.fileChanges,
        durationMs: result.durationMs,
        reconnected: result.reconnected,
      });
      return;
    }
    this.write({
      type: 'result',
      sessionId: result.sessionId,
      executionId: result.executionId,
      status: result.status,
      result: result.result,
      usage: result.usage,
      toolCalls: result.toolCalls,
      fileChanges: result.fileChanges,
      durationMs: result.durationMs,
      ...(result.reconnected ? { reconnected: true } : {}),
    });
  }

  private flushAssistant(): void {
    if (!this.opts.stream || this.opts.streamPartial) {
      this.currentText = '';
      return;
    }
    if (this.currentText) {
      this.write({ type: 'assistant', message: { content: [{ type: 'text', text: this.currentText }] } });
      this.currentText = '';
    }
  }
}
