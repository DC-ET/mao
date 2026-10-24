import { describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResponse, LlmAdapter, LlmModelConfig } from '../llm/chat-request.js';
import { DangerAssessor } from './danger-assessor.js';

/**
 * SMART 权限档的危险命令评估必须 fail-closed：
 * 只有模型明确回答 SAFE 才免审批，空响应/拒答/格式幻觉一律按危险处理。
 *
 * 现状（0.0.339）：parseVerdict 只识别 "DANGEROUS" 前缀，其余全部落到 SAFE 分支，
 * 与同文件 catch 分支（LLM 调用异常 → dangerous:true）和 dispatchior 的
 * 「approvalModel 缺失 → 需要审批」口径相反。
 */
function adapterReplying(content: string): LlmAdapter {
  return {
    async chat(_request: ChatRequest): Promise<ChatResponse> {
      return { choices: [{ message: { role: 'assistant', content } }] } as ChatResponse;
    },
    async stream(): Promise<void> {
      // 不参与安全评估
    },
  };
}

const model = { id: 1, name: 'judge' } as LlmModelConfig;
const COMMAND = JSON.stringify({ command: 'rm -rf /tmp/important' });

describe('DangerAssessor 输出不可解析时必须 fail-closed', () => {
  it('空响应按危险处理（当前被判为 SAFE 直接放行）', async () => {
    const result = await new DangerAssessor(adapterReplying('')).assess(COMMAND, model);
    expect(result.dangerous).toBe(true);
  });

  it('自然语言拒答/幻觉按危险处理（当前被判为 SAFE 直接放行）', async () => {
    for (const content of ['我觉得这个命令没问题', '看起来可以执行', '不确定']) {
      const result = await new DangerAssessor(adapterReplying(content)).assess(COMMAND, model);
      expect(result.dangerous).toBe(true);
    }
  });

  it('对照：明确 SAFE 才免审批，明确 DANGEROUS 仍拦截', async () => {
    expect((await new DangerAssessor(adapterReplying('SAFE')).assess(COMMAND, model)).dangerous).toBe(false);
    const dangerous = await new DangerAssessor(adapterReplying('DANGEROUS: 删除系统目录')).assess(COMMAND, model);
    expect(dangerous.dangerous).toBe(true);
    expect(dangerous.reason).toContain('删除系统目录');
  });

  it('对照：适配器抛错已经是 fail-closed', async () => {
    const throwing: LlmAdapter = {
      async chat(): Promise<ChatResponse> {
        throw new Error('upstream 502');
      },
      async stream(): Promise<void> {},
    };
    expect((await new DangerAssessor(throwing).assess(COMMAND, model)).dangerous).toBe(true);
  });
});
