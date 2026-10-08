import { describe, expect, it } from 'vitest';
import { parseContextManifest, toSessionVO } from './session-vo.js';

describe('parseContextManifest', () => {
  it('parses a stored snapshot and drops broken json', () => {
    const raw = JSON.stringify({
      sections: [{ key: 'messages', label: '会话消息', tokens: 4000, count: 11 }],
      memoryIds: [3],
      estimatedWindowTokens: 256000,
    });
    expect(parseContextManifest(raw)?.sections[0]?.key).toBe('messages');
    expect(parseContextManifest('not-json')).toBeNull();
    expect(parseContextManifest(null)).toBeNull();
    expect(parseContextManifest('{"sections":"nope"}')).toBeNull();
  });

  it('toSessionVO exposes the snapshot and omits it when absent', () => {
    const withManifest = toSessionVO({
      userId: 1,
      contextTokens: 21000,
      contextManifestJson: JSON.stringify({
        sections: [{ key: 'system-prompt', label: '系统提示词', tokens: 3000 }],
        memoryIds: [],
        estimatedWindowTokens: 256000,
      }),
    }, new Map(), new Map());
    expect(withManifest.contextManifest?.sections).toHaveLength(1);

    const without = toSessionVO({ userId: 1, contextTokens: 21000 }, new Map(), new Map());
    expect(without.contextManifest).toBeNull();
  });
});
