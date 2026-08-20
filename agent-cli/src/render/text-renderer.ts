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
  }

  peek(): string {
    return this.last;
  }
}
