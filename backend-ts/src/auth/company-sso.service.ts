import { createHash } from 'node:crypto';
import type { JwtService } from '../crypto/jwt.service.js';
import type { CompanySsoClient } from './company-sso.client.js';
import type { CompanySsoConfig } from './company-sso.config.js';
import type { CompanySsoIdentityRepository } from './company-sso-identity.repository.js';
import { CompanySsoError } from './company-sso.error.js';

/** Single-process, bounded fixed windows. Multi-replica deployments need gateway aggregation. */
export class CompanySsoRateLimiter {
  private readonly windows = new Map<string, { count: number; end: number }>();
  consume(key: string, limit: number): void {
    const now = Date.now();
    for (const [entry, window] of this.windows) if (window.end <= now) this.windows.delete(entry);
    const hash = createHash('sha256').update(key).digest('hex');
    let window = this.windows.get(hash);
    if (!window) {
      if (this.windows.size >= 10000) throw new CompanySsoError('rate_limited', 60);
      window = { count: 0, end: now + 60000 };
      this.windows.set(hash, window);
    }
    if (++window.count > limit) throw new CompanySsoError('rate_limited', Math.max(1, Math.ceil((window.end - now) / 1000)));
  }
}

export class CompanySsoService {
  constructor(
    private readonly config: CompanySsoConfig,
    private readonly client: Pick<CompanySsoClient, 'verify'>,
    private readonly identities: Pick<CompanySsoIdentityRepository, 'resolve'>,
    private readonly jwt: JwtService,
    private readonly limiter = new CompanySsoRateLimiter(),
  ) {}

  async exchange(token: string, checkUrl: string) {
    if (!this.config.enabled) throw new CompanySsoError('service_unavailable');
    const identity = await this.client.verify(token, checkUrl);
    this.limiter.consume(`subject:${identity.subject}`, 20);
    this.ttl(identity.expiresAt);
    const { user, action } = await this.identities.resolve(identity);
    const issued = this.jwt.generateCompanySsoToken(user.id!, user.username, this.ttl(identity.expiresAt));
    const lead = Math.min(120, issued.expiresIn * 0.2);
    return {
      action,
      ...issued,
      refreshAfter: Math.max(1, Math.floor(issued.expiresIn - lead - Math.random() * lead * 0.1)),
      user: { id: user.id!, displayName: user.displayName ?? user.username },
    };
  }

  private ttl(expiresAt: number): number {
    const remaining = Math.floor((expiresAt - Date.now()) / 1000);
    if (remaining < 30) throw new CompanySsoError('token_expiring');
    return Math.min(this.config.accessTtlSeconds, remaining);
  }
}
