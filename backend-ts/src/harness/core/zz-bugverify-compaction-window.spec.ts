/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-7）：
 * harness-service.ts:785-796 解析 agent 级 compaction 覆盖时，紧邻的两行专门为
 * triggerRatio=0（恒成立）与 triggerPayloadBytes 非法写了「退回全局默认」的兜底，注释写明
 * 「agent 级覆盖没有后台表单校验」；但 contextWindowTokens / maxSummaryTokens 两行曾直接
 * `Number(...)` 信任外部值，0 / 负数 / 非数字串（NaN）全部放行。
 * → contextWindowTokens=0 时 resolveEffectiveContextWindow 原样返回 0，shouldTrigger 的
 * `triggerWindowTokens > 0` 门恒 false，token 维度自动压缩被静默关闭；maxSummaryTokens=NaN
 * 时原样写进 handoff 指令（「正文控制在约 NaN tokens 以内」）。已修复：两行补同口径兜底。
 *
 * 本用例断言「正确行为」：非法覆盖值应退回全局默认（与 triggerRatio 同口径）。
 * 对照组：合法覆盖值今天已被尊重，证明不是「整个解析函数坏了」。
 */
import { describe, expect, it } from 'vitest';

import { CompactionConfig } from './compaction-config.js';
import { HarnessService } from './harness-service.js';

/** resolveCompactionConfig 只读 this.compactionConfig，用原型对象避免堆 27 个构造参数。 */
function makeService(global: CompactionConfig): HarnessService {
  const service = Object.create(HarnessService.prototype) as HarnessService & {
    compactionConfig: CompactionConfig;
  };
  service.compactionConfig = global;
  return service;
}

function resolve(configJson: string): CompactionConfig {
  const service = makeService(new CompactionConfig());
  const method = (service as unknown as {
    resolveCompactionConfig(agent: { configJson?: string | null }): CompactionConfig;
  }).resolveCompactionConfig.bind(service);
  return method({ configJson });
}

describe('agent 级 compaction 覆盖的越界值兜底（回归）', () => {
  it('contextWindowTokens=0 必须退回全局默认', () => {
    const merged = resolve(JSON.stringify({ compaction: { contextWindowTokens: 0 } }));
    expect(merged.contextWindowTokens).toBe(new CompactionConfig().contextWindowTokens);
  });

  it('contextWindowTokens 为负数必须退回全局默认', () => {
    const merged = resolve(JSON.stringify({ compaction: { contextWindowTokens: -1 } }));
    expect(merged.contextWindowTokens).toBe(new CompactionConfig().contextWindowTokens);
  });

  it('contextWindowTokens 为非数字串（NaN）必须退回全局默认', () => {
    const merged = resolve(JSON.stringify({ compaction: { contextWindowTokens: 'abc' } }));
    expect(Number.isFinite(merged.contextWindowTokens)).toBe(true);
    expect(merged.contextWindowTokens).toBe(new CompactionConfig().contextWindowTokens);
  });

  it('contextWindowTokens=0 会让 token 维度压缩彻底失效', () => {
    const merged = resolve(JSON.stringify({ compaction: { contextWindowTokens: 0 } }));
    // 模型未声明上下文窗口时以 agent 覆盖值为准（compaction-config.ts:21-26）
    const window = CompactionConfig.resolveEffectiveContextWindow(null, merged);
    expect(window).toBeGreaterThan(0);
    const reason = CompactionConfig.shouldTrigger({
      tokens: window, // 已撑满上下文窗口
      payloadBytes: 1,
      triggerWindowTokens: window,
      effectiveTriggerBytes: 0,
      config: merged,
    });
    expect(reason).toBe('tokens');
  });

  it('maxSummaryTokens 为 NaN 必须退回全局默认', () => {
    const merged = resolve(JSON.stringify({ compaction: { maxSummaryTokens: 'x' } }));
    expect(Number.isFinite(merged.maxSummaryTokens)).toBe(true);
    expect(merged.maxSummaryTokens).toBe(new CompactionConfig().maxSummaryTokens);
  });

  it('对照组：合法覆盖值今天已被尊重（证明解析本身在工作）', () => {
    const merged = resolve(JSON.stringify({ compaction: { contextWindowTokens: 128000, maxSummaryTokens: 4000 } }));
    expect(merged.contextWindowTokens).toBe(128000);
    expect(merged.maxSummaryTokens).toBe(4000);
  });

  it('对照组：triggerRatio=0 已有兜底（证明同函数内对称兜底是既定口径）', () => {
    const merged = resolve(JSON.stringify({ compaction: { triggerRatio: 0 } }));
    expect(merged.triggerRatio).toBe(new CompactionConfig().triggerRatio);
  });
});
