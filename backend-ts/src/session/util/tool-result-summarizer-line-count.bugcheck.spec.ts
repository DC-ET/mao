import { describe, expect, it } from 'vitest';
import { ToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * 回归用例：shell 结果摘要把结尾换行也数成一行，行数系统性多 1。
 *
 * 位置：backend-ts/src/session/util/tool-result-summarizer.ts:244-245 ——
 * `output.split('\n').length` 对结尾带 `\n` 的输出会多出一个空段。终端命令输出
 * 几乎总以换行结尾，于是「2 行输出」被显示成「3 行输出」。
 *
 * 同仓权威口径：read_file 的 splitLines 明确「末尾换行不产生空行（与 Java Files.lines 一致）」
 * （harness/tool/impl/read-file-tool.ts）。两者同为工具结果摘要，行数语义应当一致。
 *
 * 期望：'a\nb\n' → 2 行；'a\nb' → 2 行（已有用例）；'a\n' → 1 行。
 */
describe('shell result summary line count', () => {
  it('does not count the trailing newline as an extra line', () => {
    expect(ToolResultSummarizer.summarize('shell', '{"command":"ls"}', '{"exit_code":0,"output":"a\\nb\\n"}'))
      .toBe('执行 ls (2 行输出)');
  });

  it('does not count a lone trailing newline as a line', () => {
    // 单行输出本来就无括号后缀，与 'a'（无换行）行为一致
    expect(ToolResultSummarizer.summarize('shell', '{"command":"ls"}', '{"exit_code":0,"output":"a\\n"}'))
      .toBe('执行 ls');
  });

  it('keeps the existing no-trailing-newline behavior (control group)', () => {
    expect(ToolResultSummarizer.summarize('shell', '{"command":"printf"}', '{"exit_code":0,"output":"a\\nb"}'))
      .toBe('执行 printf (2 行输出)');
  });
});
