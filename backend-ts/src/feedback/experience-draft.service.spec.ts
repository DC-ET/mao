import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { LlmUsageService } from '../usage/llm-usage.service.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../usage/llm-call-context.js';
import { FEEDBACK_DRAFT_MODEL_ID_KEY } from '../settings/settings.service.js';
import type { LlmModelRef } from '../session/types.js';
import type { RunTraceVO } from '../session/session-vo.js';
import type { ChatRequest, LlmAdapter, LlmModelConfig } from '../harness/llm/chat-request.js';
import {
  ExperienceDraftService,
  DRAFT_LIMITS,
  serializeRunTrace,
  validateExperiences,
  type DraftMaterial,
} from './experience-draft.service.js';

function model(id: number, over: Partial<LlmModelRef> = {}): LlmModelRef {
  return { id, name: `m${id}`, provider: 'openai', apiProtocol: 'openai', baseUrl: 'https://x', apiKey: 'k', modelId: 'gpt', ...over };
}

function run(over: Partial<RunTraceVO> = {}): RunTraceVO {
  return {
    runId: 4,
    userMessagePreview: '帮我改一下',
    startedAt: '2026-10-11T10:00',
    segments: [{
      kind: 'current',
      rounds: [{
        seq: 1, modelName: 'gpt', scene: 'agent', createdAt: '2026-10-11 10:00:01', durationMs: 1000,
        firstTokenMs: 100, retryCount: 0, success: true, interrupted: false, errorMessage: null,
        promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheCreationTokens: 0,
        costMicros: 1, slow: false, expensive: false,
        tools: [
          { toolCallId: 'tc1', name: 'read_file', target: '/repo/src/a.ts', status: 'SUCCESS', durationMs: 120, approvalMark: null, actor: null },
          { toolCallId: 'tc2', name: 'write_file', target: '/repo/src/b.ts', status: 'ERROR', durationMs: 300, approvalMark: null, actor: null },
        ],
      }],
      unplacedTools: [],
    }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 1000, costMicros: 1, promptTokens: 10, completionTokens: 5,
      cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 1, toolError: 1,
    },
    ...over,
  };
}

function material(over: Partial<DraftMaterial> = {}): DraftMaterial {
  return {
    reason: 'WRONG_RESULT',
    reasonLabel: '结果错误',
    messageId: 12,
    userText: '帮我把构建修好',
    assistantText: '我已经改好了',
    traceText: '- read_file /repo/src/a.ts [SUCCESS] (0.1s)',
    ...over,
  };
}

/** 捕获请求体并按脚本返回响应的 adapter。 */
function makeAdapter(responses: string[]) {
  const calls: Array<{ request: ChatRequest; config: LlmModelConfig }> = [];
  let index = 0;
  const adapter: Pick<LlmAdapter, 'chat'> = {
    chat: async (request, config) => {
      calls.push({ request, config });
      const content = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { choices: [{ message: { content } }], usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } };
    },
  };
  return { adapter, calls };
}

function makeUsage() {
  const record = vi.fn(async () => undefined);
  return { record } as unknown as Pick<LlmUsageService, 'record'> & { record: ReturnType<typeof vi.fn> };
}

function makeService(options: {
  adapter: Pick<LlmAdapter, 'chat'>;
  setting?: string | null;
  models?: Record<string, LlmModelRef | null>;
  defaultModel?: LlmModelRef | null;
  existingCount?: number;
}) {
  const usage = makeUsage();
  const settingLookup = { getValue: vi.fn(async () => options.setting ?? null) };
  const modelResolver = {
    resolveModel: vi.fn(async (id: number | null | undefined) => {
      if (id == null) return options.defaultModel ?? null;
      return options.models?.[String(id)] ?? null;
    }),
  };
  const experienceCountLookup = { countByAgentId: vi.fn(async () => options.existingCount ?? 0) };
  const service = new ExperienceDraftService(
    options.adapter,
    modelResolver,
    usage,
    settingLookup,
    experienceCountLookup,
  );
  return { service, usage, settingLookup, modelResolver, experienceCountLookup };
}

const GOOD = JSON.stringify({ experiences: [{ content: '改构建脚本前先看 package.json 的 scripts，避免直接改 CI 配置。' }] });

describe('serializeRunTrace', () => {
  it('只序列化工具名/目标/状态/耗时，不含工具结果正文', () => {
    const text = serializeRunTrace(run());
    expect(text).toContain('- read_file /repo/src/a.ts [SUCCESS] (0.1s)');
    expect(text).toContain('- write_file /repo/src/b.ts [ERROR] (0.3s)');
    // 不出现轮次 token / sideCalls 等与教训无关的字段
    expect(text).not.toContain('promptTokens');
    expect(text).not.toContain('toolSuccess');
  });

  it('命中 isSensitive 的目标替换为 [sensitive]', () => {
    const text = serializeRunTrace(run({
      segments: [{
        kind: 'current',
        rounds: [{
          ...run().segments[0].rounds[0],
          tools: [
            { toolCallId: 't1', name: 'read_file', target: '/repo/.env', status: 'SUCCESS', durationMs: 10, approvalMark: null, actor: null },
            { toolCallId: 't2', name: 'read_file', target: '/repo/certs/site.pem', status: 'SUCCESS', durationMs: 10, approvalMark: null, actor: null },
            { toolCallId: 't3', name: 'read_file', target: '/repo/api_token.txt', status: 'SUCCESS', durationMs: 10, approvalMark: null, actor: null },
            { toolCallId: 't4', name: 'read_file', target: null, status: 'SUCCESS', durationMs: 10, approvalMark: null, actor: null },
          ],
        }],
        unplacedTools: [],
      }],
    }));
    expect(text).toContain('- read_file [sensitive] [SUCCESS] (0.0s)');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('.pem');
    expect(text).not.toContain('token.txt');
    // target 缺失时不拼空格占位
    expect(text.match(/\[sensitive\]/g)).toHaveLength(3);
    expect(text.split('\n')).toHaveLength(4);
  });

  it('超长轨迹只保留最后 MAX_TRACE_LINES 行', () => {
    const tools = Array.from({ length: DRAFT_LIMITS.MAX_TRACE_LINES + 5 }, (_, i) => ({
      toolCallId: `t${i}`, name: 'shell', target: `cmd${i}`, status: 'SUCCESS', durationMs: 1, approvalMark: null, actor: null,
    }));
    const text = serializeRunTrace(run({
      segments: [{ kind: 'current', rounds: [{ ...run().segments[0].rounds[0], tools }], unplacedTools: [] }],
    }));
    expect(text).toContain(`仅保留最后 ${DRAFT_LIMITS.MAX_TRACE_LINES} 行`);
    const lines = text.split('\n');
    expect(lines).toHaveLength(DRAFT_LIMITS.MAX_TRACE_LINES + 1);
    // 保留的是最后若干行：第一条被截掉的命令不出现在结果里
    expect(text).not.toContain('cmd0 ');
    expect(text).toContain(`cmd${DRAFT_LIMITS.MAX_TRACE_LINES + 4}`);
  });

  it('没有工具调用时给出占位说明', () => {
    expect(serializeRunTrace(run({ segments: [{ kind: 'current', rounds: [], unplacedTools: [] }] })))
      .toBe('（该轮没有任何工具调用记录）');
  });

  it('超长目标按码点截断：emoji / CJK 扩展 B 不被切成孤立代理对', () => {
    for (const char of ['😀', '\u{20000}']) {
      const target = `echo ${char.repeat(DRAFT_LIMITS.MAX_TRACE_TARGET_CHARS + 40)}`;
      const text = serializeRunTrace(run({
        segments: [{
          kind: 'current',
          rounds: [{ ...run().segments[0].rounds[0], tools: [
            { toolCallId: 't1', name: 'shell', target, status: 'SUCCESS', durationMs: 1, approvalMark: null, actor: null },
          ] }],
          unplacedTools: [],
        }],
      }));
      const body = text.split('\n')[0].slice(0, text.indexOf('…'));
      const last = body.slice(-1);
      // 孤立高位代理：0xD800~0xDBFF 且后面没有低位代理
      const isLoneSurrogate = /[\uD800-\uDBFF]$/.test(body) && !/[\uDC00-\uDFFF]/.test(last);
      expect(isLoneSurrogate).toBe(false);
      // 截断后仍含省略号，且整个字符串可被 JSON 序列化（乱码代理对会让 JSON.stringify 正常但内容不可读）
      expect(text).toContain('…');
      expect(JSON.parse(JSON.stringify({ text })).text).toBe(text);
    }
  });
});

describe('validateExperiences', () => {
  it('接受 1～2 条且每条不超 300 字', () => {
    expect(validateExperiences(GOOD)).toBeNull();
    expect(validateExperiences(JSON.stringify({ experiences: [{ content: '甲' }, { content: '乙' }] }))).toBeNull();
  });

  it('容忍 Markdown 代码围栏', () => {
    expect(validateExperiences(`\`\`\`json\n${GOOD}\n\`\`\``)).toBeNull();
  });

  it('拒绝空输出、非 JSON、缺字段、越界条数、越界字数', () => {
    expect(validateExperiences('')).toBe('输出为空');
    expect(validateExperiences('  ')).toBe('输出为空');
    expect(validateExperiences('not json')).toBe('输出不是合法 JSON');
    expect(validateExperisesArrayShape(JSON.stringify([{ content: 'x' }]))).toBe('输出必须是 JSON 对象');
    expect(validateExperiences(JSON.stringify({ items: [] }))).toBe('缺少 experiences 数组');
    expect(validateExperiences(JSON.stringify({ experiences: [] }))).toBe('experiences 不能为空');
    expect(validateExperiences(JSON.stringify({ experiences: [{ content: '甲' }, { content: '乙' }, { content: '丙' }] })))
      .toBe(`experiences 最多 ${DRAFT_LIMITS.MAX_EXPERIENCES} 条`);
    expect(validateExperiences(JSON.stringify({ experiences: [{ content: 'x'.repeat(301) }] })))
      .toBe(`经验内容超过 ${DRAFT_LIMITS.MAX_CONTENT_LENGTH} 字`);
    expect(validateExperiences(JSON.stringify({ experiences: [{ content: '   ' }] }))).toBe('经验内容不能为空');
  });
});

/** 数组是合法 JSON 但不是对象：单独包一层让断言可读。 */
function validateExperisesArrayShape(raw: string): string | null {
  return validateExperiences(raw);
}

describe('ExperienceDraftService.draft', () => {
  it('N=1 走单条 prompt，附目标 Agent 现有经验条数', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service } = makeService({ adapter, defaultModel: model(3), existingCount: 4 });
    const result = await service.draft(9, 7, [material()]);
    expect(result.experiences).toHaveLength(1);
    const userPrompt = calls[0].request.messages![1].content;
    expect(userPrompt).toContain('以下是一条用户点踩反馈');
    expect(userPrompt).toContain('目标 Agent id=7（已有 4 条经验）');
    expect(userPrompt).toContain('点踩原因：结果错误');
    expect(userPrompt).toContain('被点踩的回复：');
    expect(userPrompt).not.toContain('promptTokens');
    // 系统提示声明只输出 JSON、禁臆测、禁围栏
    expect(calls[0].request.messages![0].content).toContain('只输出 JSON');
  });

  it('N≥2 走归纳 prompt，并要求 1～2 条', async () => {
    const { adapter, calls } = makeAdapter([JSON.stringify({ experiences: [{ content: '甲甲甲' }, { content: '乙乙乙' }] })]);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    const result = await service.draft(9, null, [material(), material({ messageId: 13, reason: 'NOT_SOLVED', reasonLabel: '问题未解决' })]);
    expect(result.experiences.map((e) => e.content)).toEqual(['甲甲甲', '乙乙乙']);
    const userPrompt = calls[0].request.messages![1].content;
    expect(userPrompt).toContain('以下是 2 条用户点踩反馈');
    expect(userPrompt).toContain('归纳出 1～2 条更通用的经验');
    expect(userPrompt).toContain('目标 Agent 未指定');
    expect(userPrompt).toContain('### 反馈 2');
  });

  it('agentId 为 null 时不查经验条数', async () => {
    const { adapter } = makeAdapter([GOOD]);
    const { service, experienceCountLookup } = makeService({ adapter, defaultModel: model(3) });
    await service.draft(9, null, [material()]);
    expect(experienceCountLookup.countByAgentId).not.toHaveBeenCalled();
  });

  it('原料为空直接拒绝，不调模型', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service } = makeService({ adapter });
    await expect(service.draft(9, 7, [])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(calls).toHaveLength(0);
  });

  it('默认模型解析失败抛 MODEL_NOT_FOUND', async () => {
    const { adapter } = makeAdapter([GOOD]);
    const { service } = makeService({ adapter, defaultModel: null });
    await expect(service.draft(9, 7, [material()])).rejects.toMatchObject({ code: ErrorCode.MODEL_NOT_FOUND.code });
  });

  it('feedback.draftModelId 未配置时回落默认模型', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service, modelResolver } = makeService({ adapter, defaultModel: model(3), existingCount: 0 });
    await service.draft(9, 7, [material()]);
    expect(modelResolver.resolveModel).toHaveBeenCalledWith(null);
    expect(calls[0].config.id).toBe(3);
  });

  it('feedback.draftModelId 配了不存在的 id 时回落默认模型', async () => {
    const { adapter } = makeAdapter([GOOD]);
    const { service, modelResolver } = makeService({ adapter, setting: '99', defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(modelResolver.resolveModel).toHaveBeenCalledWith(99);
    expect(modelResolver.resolveModel).toHaveBeenCalledWith(null);
  });

  it('feedback.draftModelId 非法值回落默认模型', async () => {
    const { adapter } = makeAdapter([GOOD]);
    const { service, modelResolver } = makeService({ adapter, setting: 'abc', defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(modelResolver.resolveModel).toHaveBeenCalledWith(null);
    expect(modelResolver.resolveModel).not.toHaveBeenCalledWith(expect.anything());
  });

  it('配了有效模型时优先使用', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service, modelResolver } = makeService({ adapter, setting: ' 5 ', models: { '5': model(5) }, defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(modelResolver.resolveModel).toHaveBeenCalledWith(5);
    expect(modelResolver.resolveModel).not.toHaveBeenCalledWith(null);
    expect(calls[0].config.id).toBe(5);
  });

  it('非法 JSON 纠错一次后成功', async () => {
    const { adapter, calls } = makeAdapter(['这不是 JSON', GOOD]);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    const result = await service.draft(9, 7, [material()]);
    expect(result.experiences).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // 第二次带上了上次输出与纠错说明
    expect(calls[1].request.messages![2].content).toBe('这不是 JSON');
    expect(calls[1].request.messages![3].content).toContain('上次输出不合规');
  });

  it('连续两次不合规抛 LLM_CALL_FAILED，不写任何状态', async () => {
    const { adapter, calls } = makeAdapter(['坏输出', '还是坏输出']);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    await expect(service.draft(9, 7, [material()])).rejects.toMatchObject({ code: ErrorCode.LLM_CALL_FAILED.code });
    expect(calls).toHaveLength(2);
  });

  it('条数越界也走一次纠错', async () => {
    const three = JSON.stringify({ experiences: [{ content: '甲' }, { content: '乙' }, { content: '丙' }] });
    const { adapter, calls } = makeAdapter([three, GOOD]);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    const result = await service.draft(9, 7, [material()]);
    expect(result.experiences).toHaveLength(1);
    expect(calls[1].request.messages![3].content).toContain('最多 2 条');
  });

  it('模型调用失败抛 LLM_CALL_FAILED 且用量记 success=false', async () => {
    const record = vi.fn(async () => undefined);
    const adapter: Pick<LlmAdapter, 'chat'> = { chat: async () => { throw new Error('boom'); } };
    const service = new ExperienceDraftService(
      adapter,
      { resolveModel: async () => model(3) },
      { record } as unknown as Pick<LlmUsageService, 'record'>,
      { getValue: async () => null },
      { countByAgentId: async () => 0 },
    );
    await expect(service.draft(9, 7, [material()])).rejects.toMatchObject({ code: ErrorCode.LLM_CALL_FAILED.code });
    expect(record).toHaveBeenCalledWith(9, null, 3, LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT, null, false);
  });

  it('模型返回空内容抛 LLM_CALL_FAILED', async () => {
    const { adapter } = makeAdapter(['']);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    await expect(service.draft(9, 7, [material()])).rejects.toMatchObject({ code: ErrorCode.LLM_CALL_FAILED.code });
  });

  it('超时抛 LLM_TIMEOUT 并触发 cancelFlag', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const adapter: Pick<LlmAdapter, 'chat'> = {
        chat: async (_req, _config, cancelFlag) => new Promise((_resolve, reject) => {
          // 模拟流式调用被取消：超时回调置 cancelFlag 后适配器据此中止并拒绝
          const timer = setInterval(() => {
            if (cancelFlag?.get()) {
              clearInterval(timer);
              cancelled = true;
              reject(new Error('aborted'));
            }
          }, 10);
        }),
      };
      const service = new ExperienceDraftService(
        adapter,
        { resolveModel: async () => model(3) },
        makeUsage(),
        { getValue: async () => null },
        { countByAgentId: async () => 0 },
      );
      const pending = service.draft(9, 7, [material()]).catch((e) => e);
      // 先推进到超时点（reject 传播），再推进一点让适配器的取消轮询观察到 cancelFlag
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await pending;
      await vi.advanceTimersByTimeAsync(50);
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).code).toBe(ErrorCode.LLM_TIMEOUT.code);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用量落一行：scene/user_id/agent_id/success 正确，计入 LlmCallContext', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service, usage } = makeService({ adapter, defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(usage.record).toHaveBeenCalledWith(
      9, null, 3, LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT,
      { promptTokens: 7, completionTokens: 3, totalTokens: 10 }, true,
    );
    expect(LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT).toBe(LLM_CALL_SCENES.FEEDBACK_EXPERIENCE_DRAFT);
    expect(LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT).toBe('feedback_experience_draft');
    // 调用发生在 scene 上下文内（供 llm_call 落库归属）
    expect(calls[0].request.messages).toHaveLength(2);
    expect(LlmCallContext.get()).toBeUndefined();
  });

  it('每次 invoke 都落用量：纠错场景落两行', async () => {
    const { adapter } = makeAdapter(['坏', GOOD]);
    const { service, usage } = makeService({ adapter, defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(usage.record).toHaveBeenCalledTimes(2);
  });

  it('按 feedback.draftModelId 读取系统设置', async () => {
    const { adapter } = makeAdapter([GOOD]);
    const { service, settingLookup } = makeService({ adapter, defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(settingLookup.getValue).toHaveBeenCalledWith(FEEDBACK_DRAFT_MODEL_ID_KEY);
  });

  it('temperature 与思考开关按后台调用惯例关闭', async () => {
    const { adapter, calls } = makeAdapter([GOOD]);
    const { service } = makeService({ adapter, defaultModel: model(3) });
    await service.draft(9, 7, [material()]);
    expect(calls[0].request).toMatchObject({
      tools: [],
      stream: false,
      temperature: 0.3,
      reasoning: { effort: 'none' },
      thinking: { type: 'disabled' },
      enableThinking: false,
    });
  });
});
