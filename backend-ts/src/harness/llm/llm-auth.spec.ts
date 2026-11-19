import { describe, expect, it } from 'vitest';
import { createLlmAuthResolver, createStaticOnlyAuthResolver } from './llm-auth.js';
import { LlmCallContext } from '../../usage/llm-call-context.js';
import type { EcpTokenLookup, EcpTokenProvider } from '../../auth/ecp-token-provider.js';

function providerOf(lookup: EcpTokenLookup): EcpTokenProvider {
  return { getUsableToken: async () => lookup };
}

describe('llmAuthResolver', () => {
  it('usesConfiguredApiKeyForStaticMode', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: false, reason: 'no_session' }));
    await expect(resolver.resolveApiKey({ apiKey: 'sk-1', authType: 'api_key' })).resolves.toBe('sk-1');
  });

  it('treatsMissingAuthTypeAsStatic', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: true, token: 'should-not-use' }));
    await expect(resolver.resolveApiKey({ apiKey: 'sk-1' })).resolves.toBe('sk-1');
  });

  it('usesEcpTokenInsideCallContext', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: true, token: 'ecp-plain-token' }));
    const key = await LlmCallContext.runAsync({ scene: 'agent', userId: 7 }, async () =>
      resolver.resolveApiKey({ apiKey: 'sk-1', authType: 'ecp', modelId: 'm1' }));
    expect(key).toBe('ecp-plain-token');
  });

  it('throwsWithoutUserContext', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: true, token: 'ecp-plain-token' }));
    await expect(resolver.resolveApiKey({ authType: 'ecp' })).rejects.toThrow('没有用户上下文');
  });

  it('neverFallsBackToConfiguredKeyWhenTokenUnavailable', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: false, reason: 'no_session' }));
    let message = '';
    await LlmCallContext.runAsync({ scene: 'agent', userId: 7 }, async () => {
      await resolver
        .resolveApiKey({ apiKey: 'sk-should-not-leak', authType: 'ecp', modelId: 'm1' })
        .catch((e: Error) => { message = e.message; });
    });
    expect(message).toContain('ECP 飞书登录');
    expect(message).not.toContain('sk-should-not-leak');
  });

  it('mentionsDisabledWhenEcpLoginOff', async () => {
    const resolver = createLlmAuthResolver(providerOf({ ok: false, reason: 'disabled' }));
    await expect(
      LlmCallContext.runAsync({ scene: 'agent', userId: 7 }, async () =>
        resolver.resolveApiKey({ authType: 'ecp', modelId: 'm1' })),
    ).rejects.toThrow('未启用 ECP 飞书登录');
  });

  it('prefers explicit userId over call context', async () => {
    const captured: number[] = [];
    const provider: EcpTokenProvider = {
      getUsableToken: async (userId) => {
        captured.push(userId);
        return { ok: true, token: 'ecp-plain-token' };
      },
    };
    const resolver = createLlmAuthResolver(provider);
    const key = await LlmCallContext.runAsync({ scene: 'agent', userId: 7 }, async () =>
      resolver.resolveApiKey({ authType: 'ecp', modelId: 'm1' }, 42));
    expect(key).toBe('ecp-plain-token');
    expect(captured).toEqual([42]);
  });

  it('staticOnlyResolverRejectsEcpMode', async () => {
    await expect(
      createStaticOnlyAuthResolver().resolveApiKey({ authType: 'ecp', apiKey: 'k' }),
    ).rejects.toThrow('未装配');
  });

  it('staticOnlyResolverPassesThroughConfiguredKey', async () => {
    await expect(
      createStaticOnlyAuthResolver().resolveApiKey({ apiKey: 'sk-1', authType: 'api_key' }),
    ).resolves.toBe('sk-1');
  });
});
