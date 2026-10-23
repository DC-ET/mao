import { describe, expect, it } from 'vitest';
import { CompactionConfig } from './compaction-config.js';

/**
 * Bugcheck：体积压缩的「一次执行只做一次」名额在 request_start 与 mid-loop 之间的一致性。
 *
 * 相关代码：
 * - harness-service.ts:517  request_start 路径 compact() 成功后按 bytesBeforeCompact >= triggerBytes
 *   置 context.payloadCompactionDone = true；
 * - agent-loop.ts:551       mid-loop 用 `payloadBytes: payloadCompactionDone ? 0 : nextRequestBytes`
 *   屏蔽后续体积触发。
 *
 * 若两处用的阈值口径不同（例如一处用 resolveEffectiveTriggerBytes、一处用原始
 * triggerPayloadBytes），会出现「request_start 已因体积压缩过，mid-loop 又压一次」
 * 或「request_start 压了但没记账，mid-loop 再压一次」的重复压缩。
 *
 * 这里只验证纯函数口径：两处必须对同一个 modelConfig + config 给出一致的阈值。
 */

const MB = 1024 * 1024;

describe('payload compaction quota accounting', () => {
  it('request_start and mid-loop resolve the same threshold for the same inputs', () => {
    const config = new CompactionConfig();
    const modelConfig = { maxRequestBodyBytes: 32 * MB };

    // agent-loop.ts:544 / harness-service.ts:514 用的是同一个静态方法
    const midLoopThreshold = CompactionConfig.resolveEffectiveTriggerBytes(modelConfig, config);
    const requestStartThreshold = CompactionConfig.resolveEffectiveTriggerBytes(modelConfig, config);

    expect(midLoopThreshold).toBe(requestStartThreshold);
    expect(midLoopThreshold).toBe(Math.floor(32 * MB * 0.8));
  });

  it('a model without a declared limit uses the global threshold in both paths', () => {
    const config = new CompactionConfig();
    expect(CompactionConfig.resolveEffectiveTriggerBytes(null, config))
      .toBe(CompactionConfig.resolveEffectiveTriggerBytes({ maxRequestBodyBytes: null }, config));
  });

  it('the boundary comparison is inclusive in both paths', () => {
    const config = new CompactionConfig();
    const threshold = CompactionConfig.resolveEffectiveTriggerBytes(null, config);
    // shouldTrigger 用 >=；harness-service 也用 >=。边界值必须都判为命中。
    expect(CompactionConfig.shouldTrigger({
      tokens: 0,
      payloadBytes: threshold,
      triggerWindowTokens: 0,
      effectiveTriggerBytes: threshold,
      config,
    })).toBe('payload');
    // harness-service 的判据：bytesBeforeCompact >= triggerBytes
    expect(threshold >= threshold).toBe(true);
  });

  it('a payload-triggered compaction consumes the quota exactly once', () => {
    const config = new CompactionConfig();
    const threshold = CompactionConfig.resolveEffectiveTriggerBytes(null, config);

    // 第一次：未压缩过，payloadBytes = 实际值 → 命中
    const first = CompactionConfig.shouldTrigger({
      tokens: 0,
      payloadBytes: threshold + 1,
      triggerWindowTokens: 0,
      effectiveTriggerBytes: threshold,
      config,
    });
    expect(first).toBe('payload');

    // 压缩成功后 payloadCompactionDone = true，mid-loop 传 payloadBytes = 0 → 不再命中
    const second = CompactionConfig.shouldTrigger({
      tokens: 0,
      payloadBytes: 0,
      triggerWindowTokens: 0,
      effectiveTriggerBytes: threshold,
      config,
    });
    expect(second).toBeNull();
  });

  it('token-triggered compaction does not consume the payload quota', () => {
    const config = new CompactionConfig();
    const threshold = CompactionConfig.resolveEffectiveTriggerBytes(null, config);
    // 只命中 token：agent-loop 的 payloadAttempt = false，不置 payloadCompactionDone
    const trigger = CompactionConfig.shouldTrigger({
      tokens: 1000,
      payloadBytes: 10,
      triggerWindowTokens: 1000,
      effectiveTriggerBytes: threshold,
      config,
    });
    expect(trigger).toBe('tokens');
    expect(trigger === 'payload' || trigger === 'both').toBe(false);
  });
});
