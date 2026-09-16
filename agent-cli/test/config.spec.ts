import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl } from '../src/args';
import { pickLatestSession } from '../src/session/session-runner';
import type { SessionVO } from '../src/rest/types';

describe('normalizeBaseUrl', () => {
  it('accepts origin, /api, and /api/v1', () => {
    expect(normalizeBaseUrl('https://mao.example.com')).toBe('https://mao.example.com/api');
    expect(normalizeBaseUrl('https://mao.example.com/')).toBe('https://mao.example.com/api');
    expect(normalizeBaseUrl('https://mao.example.com/api')).toBe('https://mao.example.com/api');
    expect(normalizeBaseUrl('https://mao.example.com/api/v1')).toBe('https://mao.example.com/api');
    expect(normalizeBaseUrl('https://mao.example.com/api/v1/')).toBe('https://mao.example.com/api');
    expect(normalizeBaseUrl('http://127.0.0.1:9080')).toBe('http://127.0.0.1:9080/api');
  });
});

describe('pickLatestSession', () => {
  it('re-sorts by updatedAt so pinned sessions do not win', () => {
    const list: SessionVO[] = [
      { id: 1, isPinned: true, updatedAt: '2026-01-01T00:00:00', status: 'ACTIVE' },
      { id: 2, isPinned: false, updatedAt: '2026-08-01T00:00:00', status: 'ACTIVE' },
    ];
    expect(pickLatestSession(list)?.id).toBe(2);
  });
});
