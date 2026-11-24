import { describe, expect, it, vi } from 'vitest';
import { createImageCallRecorder } from './image-call-recorder.js';
import { LlmCallContext, LLM_CALL_SCENES } from './llm-call-context.js';
import type { LlmCallRecordInput, LlmCallService } from './llm-call.service.js';

function stubService() {
  const record = vi.fn<(input: LlmCallRecordInput) => Promise<void>>(async () => {});
  return { record, service: { record } as unknown as LlmCallService };
}

const baseInput = {
  model: { id: 42, name: 'GPT image 2', provider: 'openai', apiProtocol: 'openai-compatible' },
  resolvedModelName: 'gpt-image-2.5-sunburst',
  usage: { promptTokens: 1840, completionTokens: 4096, totalTokens: 5936 },
  success: true,
  durationMs: 8231,
  userId: 7,
  sessionId: 1024,
  agentId: 3,
};

describe('createImageCallRecorder', () => {
  it('records with scene=image_generation and an explicit zero cost (D3)', async () => {
    const { record, service } = stubService();
    await createImageCallRecorder(service).record(baseInput);

    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0]![0];
    expect(input.stream).toBe(false);
    // 显式 0 = 已知零价（SUM 计入、总额不变）；绝不能是 undefined（走兜底价格解析 → NULL）
    expect(input.costMicros).toBe(0);
    expect(input.usage).toEqual({ promptTokens: 1840, completionTokens: 4096, totalTokens: 5936 });
    expect(input.success).toBe(true);
    expect(input.durationMs).toBe(8231);
    expect(input.modelConfig).toEqual({
      id: 42,
      name: 'GPT image 2',
      provider: 'openai',
      apiProtocol: 'openai-compatible',
      modelId: 'gpt-image-2.5-sunburst',
    });
  });

  it('publishes user/session/agent through LlmCallContext so record can read them', async () => {
    const { record, service } = stubService();
    let seen: ReturnType<typeof LlmCallContext.get>;
    const spy = vi.fn(async (input: LlmCallRecordInput) => {
      seen = LlmCallContext.get();
      void input;
    });
    await createImageCallRecorder({ record: spy } as unknown as LlmCallService).record(baseInput);

    expect(seen).toEqual({ scene: 'image_generation', userId: 7, sessionId: 1024, agentId: 3 });
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the scene constant in LLM_CALL_SCENES (no string drift)', async () => {
    const { service } = stubService();
    await createImageCallRecorder(service).record(baseInput);
    expect(LLM_CALL_SCENES.IMAGE_GENERATION).toBe('image_generation');
  });

  it('passes through the failure row with a null usage', async () => {
    const { record, service } = stubService();
    await createImageCallRecorder(service).record({
      ...baseInput,
      usage: null,
      success: false,
      errorMessage: 'upstream 502',
    });
    const input = record.mock.calls[0]![0];
    expect(input.success).toBe(false);
    expect(input.errorMessage).toBe('upstream 502');
    expect(input.usage).toBeNull();
  });

  it('falls back to null snapshot columns when the model row itself is unavailable', async () => {
    const { record, service } = stubService();
    await createImageCallRecorder(service).record({ ...baseInput, model: null, resolvedModelName: '' });
    expect(record.mock.calls[0]![0].modelConfig).toEqual({
      id: undefined,
      name: null,
      provider: null,
      apiProtocol: null,
      modelId: '',
    });
  });

  it('swallows a record failure instead of propagating it (D8)', async () => {
    const boom = vi.fn(async () => { throw new Error('db down'); });
    const recorder = createImageCallRecorder({ record: boom } as unknown as LlmCallService);
    await expect(recorder.record(baseInput)).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
