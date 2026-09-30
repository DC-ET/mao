import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevRiskAssessor } from './jev-risk-assessor.js';

describe('JevRiskAssessor', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function settings(overrides: { endpoint?: string; model?: string; apiKey?: string } = {}) {
    const values: Record<string, string> = {
      'approval.jev.endpoint': overrides.endpoint ?? 'https://api.typesafe.ai/v1/systemone',
      'approval.jev.model': overrides.model ?? 'jev-latest',
    };
    return {
      getValue: vi.fn(async (key: string) => values[key] ?? null),
      getSecretValue: vi.fn(async () => overrides.apiKey ?? 'test-key'),
    };
  }

  function okResponse(probability: number) {
    return {
      ok: true,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: { high_risk: { type: 'noul', noul: probability } },
        usage: { input_tokens: 427, output_tokens: 22 },
      }),
      text: async () => '',
    } as unknown as Response;
  }

  it('returns not-configured when apiKey is empty and never calls fetch', async () => {
    const assessor = new JevRiskAssessor(settings({ apiKey: '' }));
    const result = await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{"command":"ls"}' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('jev not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks low risk below threshold', async () => {
    fetchMock.mockResolvedValue(okResponse(0.03));
    const assessor = new JevRiskAssessor(settings());
    const result = await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{"command":"ls"}' });
    expect(result).toMatchObject({ ok: true, highRisk: false, probability: 0.03 });
  });

  it('marks high risk at or above threshold 0.3', async () => {
    const assessor = new JevRiskAssessor(settings());
    fetchMock.mockResolvedValue(okResponse(0.29));
    expect((await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' })).highRisk).toBe(false);
    fetchMock.mockResolvedValue(okResponse(0.3));
    expect((await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' })).highRisk).toBe(true);
    fetchMock.mockResolvedValue(okResponse(0.98));
    expect((await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' })).highRisk).toBe(true);
  });

  it('sends configured endpoint and model with bearer auth', async () => {
    fetchMock.mockResolvedValue(okResponse(0.5));
    const assessor = new JevRiskAssessor(settings({
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: 'sk-or-test',
    }));
    await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{"command":"rm -rf /"}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(String(init.body)) as { model: string; state: { arguments: { command: string } } };
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state.arguments.command).toBe('rm -rf /');
  });

  it('returns ok=false on http error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response);
    const assessor = new JevRiskAssessor(settings());
    const result = await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http 401');
  });

  it('returns ok=false on unparseable response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { high_risk: { type: 'choice', choice: 'yes' } } }),
    } as unknown as Response);
    const assessor = new JevRiskAssessor(settings());
    expect((await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' })).ok).toBe(false);
  });

  it('returns ok=false when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const assessor = new JevRiskAssessor(settings());
    const result = await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network down');
  });

  it('returns ok=false when settings read fails', async () => {
    const assessor = new JevRiskAssessor({
      getValue: vi.fn(),
      getSecretValue: vi.fn(async () => { throw new Error('db down'); }),
    });
    const result = await assessor.assessRisk({ toolName: 'shell', argumentsJson: '{}' });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes raw string state when argumentsJson is not valid JSON', async () => {
    fetchMock.mockResolvedValue(okResponse(0.1));
    const assessor = new JevRiskAssessor(settings());
    await assessor.assessRisk({ toolName: 'shell', argumentsJson: 'not-json' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { state: { arguments: unknown } };
    expect(body.state.arguments).toBe('not-json');
  });
});
