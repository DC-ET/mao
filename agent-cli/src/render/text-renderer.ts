import type { CliEvent, Renderer, RunResult } from './types';

/** text 模式：只输出本轮最后一个 assistant 文本块，无装饰。 */
export class TextRenderer implements Renderer {
  private last = '';
  private current = '';

  onEvent(evt: CliEvent): void {
    if (evt.type === 'content_delta') {
      this.current += evt.delta;
      this.last = this.current;
    } else if (evt.type === 'tool_call_start' || evt.type === 'llm_stream_reset') {
      this.current = '';
      this.last = '';
    }
  }

  finish(result: RunResult): void {
    const text = result.result || this.last;
    if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    // 失败原因只走 stderr：stdout 保持「只含正文」的契约（管道消费方不受影响），
    // 同时不让 error 帧的内容随 status 一起被丢掉。
    if (result.status === 'FAILED' && result.error) {
      process.stderr.write(`执行失败：${result.error}\n`);
    }
  }

  peek(): string {
    return this.last;
  }
}
