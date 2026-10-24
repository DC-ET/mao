import { describe, expect, it } from 'vitest';
import { compactToolResult } from './admin-message-compact.js';

/**
 * 管理端 compact 载荷（SessionDetailView 恒带 compact=true）必须保留工具失败态。
 *
 * shell 工具的真实载荷键序是 exit_code 在最前（shell-session-tool.ts formatResult），
 * 输出大时 compactToolResult 只保留前 4000 字；admin 前端 inferToolStatus 对截断文本
 * JSON.parse 失败后只能靠 "Tool execution failed" 前缀识别失败。isToolError 却只扫
 * 末尾 500 字，于是「失败 + 输出超过 4000 字」的调用在管理后台显示为成功。
 */
function shellPayload(exitCode: number, outputSize: number): string {
  return JSON.stringify({
    exit_code: exitCode,
    session_id: 'shell-1',
    output: 'boom\n'.repeat(Math.ceil(outputSize / 5)),
    truncated: false,
    completed: true,
    current_workdir: '/workspace',
    output_file: '/tmp/out.log',
  });
}

describe('compactToolResult 必须保留失败态标记', () => {
  it('exit_code 在头部 + 输出超长时仍应判定失败（当前显示为成功）', () => {
    const compact = compactToolResult(shellPayload(1, 8000));
    expect(compact).toBeTruthy();
    expect(compact!.startsWith('Tool execution failed')).toBe(true);
  });

  it('超时/被 kill 的 -1 也应判定失败（当前显示为成功）', () => {
    const compact = compactToolResult(shellPayload(-1, 8000));
    expect(compact!.startsWith('Tool execution failed')).toBe(true);
  });

  it('对照：成功的长输出不加失败前缀', () => {
    const compact = compactToolResult(shellPayload(0, 8000));
    expect(compact!.startsWith('Tool execution failed')).toBe(false);
  });

  it('对照：短失败结果原样返回（前端可直接解析 exit_code）', () => {
    const short = shellPayload(2, 20);
    expect(compactToolResult(short)).toBe(short);
    expect(JSON.parse(short).exit_code).toBe(2);
  });
});
