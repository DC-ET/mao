import { CompanySsoError } from './company-sso.error.js';
import { validateCompanySsoCheckUrl, validateCompanySsoConfig, type CompanySsoConfig } from './company-sso.config.js';

export interface VerifiedSsoIdentity {
  subject: string;
  email: string;
  displayName: string;
  expiresAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class CompanySsoClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async verify(token: string, checkUrl: string, config: CompanySsoConfig): Promise<VerifiedSsoIdentity> {
    validateCompanySsoConfig(config);
    const url = validateCompanySsoCheckUrl(checkUrl, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      url.searchParams.set('token', token);
      const response = await this.fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new CompanySsoError('service_unavailable');
      if (Number(response.headers.get('content-length')) > 65536 || !response.body) throw new CompanySsoError('service_unavailable');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) throw new CompanySsoError('service_unavailable');
        chunks.push(part.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(body) || body.code !== 0 || body.success !== true || !record(body.data)) throw new CompanySsoError('service_unavailable');
      if (body.data.illegal === true) throw new CompanySsoError('invalid_token');
      if (body.data.illegal !== false || !record(body.data.claims)) throw new CompanySsoError('service_unavailable');
      const claims = body.data.claims;
      // Company claims.id is the binding key, NOT sub. External owner must confirm id is never reused.
      if (typeof claims.id !== 'number' || !Number.isSafeInteger(claims.id) || claims.id <= 0
        || typeof claims.email !== 'string' || claims.email.length > 128 || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(claims.email)
        || typeof claims.realName !== 'string' || !claims.realName.trim() || claims.realName.length > 128
        || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.exp * 1000)) throw new CompanySsoError('service_unavailable');
      if (claims.exp * 1000 <= Date.now()) throw new CompanySsoError('invalid_token');
      return { subject: String(claims.id), email: claims.email, displayName: claims.realName.trim(), expiresAt: claims.exp * 1000 };
    } catch (error) {
      if (error instanceof CompanySsoError) throw error;
      // Never propagate fetch errors: they may contain the credential-bearing URL.
      throw new CompanySsoError('service_unavailable');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      clearTimeout(timer);
    }
  }
}
