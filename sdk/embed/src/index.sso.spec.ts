import { describe, expect, it, vi, beforeEach } from 'vitest';
import { init } from './index';

vi.mock('./controller', () => ({
  createUiState: vi.fn(() => ({})), mountApp: vi.fn(() => ({ cleanup: vi.fn(), root: {}, host: null })),
  EmbedController: vi.fn(function () { return { open: vi.fn(), close: vi.fn(), toggle: vi.fn(), newSession: vi.fn(), setContext: vi.fn(), destroy: vi.fn() }; }),
}));
vi.mock('./ui/theme', () => ({ applyTheme: vi.fn() }));

const base = () => ({ serverUrl: 'https://mao.example.test', agentId: 9, auth: { type: 'company-sso' as const, getSsoToken: async () => 'sso', checkUrl: 'https://portal.example.net/sso/check' } });
beforeEach(() => { window.__maoChatInstance?.destroy(); window.__maoChatInstance = undefined; });

describe('MaoChat.init SSO checkUrl', () => {
  it.each([undefined, 1, 'http://portal.example.net/x', 'https://u:p@portal.example.net/x', 'https://portal.example.net/x#', 'https://portal.example.net/x?token=', 'https://portal.example.net/ x', 'https://portal.example.net/\\x', 'x'.repeat(2049)])('rejects invalid checkUrl %s', (value) => {
    const options = base(); (options.auth as any).checkUrl = value;
    expect(() => init(options)).toThrow();
  });
  it('accepts and passes a legal checkUrl', () => expect(() => init(base())).not.toThrow());
  it('keeps getToken and SSO mutually exclusive', () => {
    expect(() => init({ ...base(), getToken: async () => 'x' } as any)).toThrow(/exactly one/);
  });
});
