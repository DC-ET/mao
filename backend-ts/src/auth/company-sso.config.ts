import { isIP } from 'node:net';
import { CompanySsoError } from './company-sso.error.js';

export interface CompanySsoConfig {
  enabled: boolean;
  allowedDomains: string[];
  allowedOrigins: string[];
  accessTtlSeconds: number;
  timeoutMs: number;
  requireHttps: true;
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)
    || value.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('Invalid SSO allowed domain');
  }
  const hostname = new URL(`https://${value}`).hostname;
  if (isIP(hostname) || hostname !== value.toLowerCase()) throw new Error('Invalid SSO allowed domain');
  return hostname;
}

/** Trust is assigned by configuration, not DNS resolution or a private-network policy. */
export function validateCompanySsoCheckUrl(checkUrl: unknown, config: CompanySsoConfig): URL {
  try {
    if (typeof checkUrl !== 'string' || checkUrl.length > 2048 || !/^https:\/\//i.test(checkUrl)
      || /[\s\\#]/.test(checkUrl)) throw new Error();
    const url = new URL(checkUrl);
    const authority = checkUrl.slice(checkUrl.indexOf('://') + 3).split(/[/?]/, 1)[0];
    if (url.protocol !== 'https:' || !authority || authority.includes('@') || url.username || url.password || url.hash
      || normalizeDomain(url.hostname) !== url.hostname
      || !config.allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      || [...url.searchParams.keys()].some((key) => key.toLowerCase() === 'token')) throw new Error();
    return url;
  } catch {
    throw new CompanySsoError('invalid_request');
  }
}

export function validateCompanySsoConfig(config: CompanySsoConfig): CompanySsoConfig {
  if (typeof config.enabled !== 'boolean' || config.requireHttps !== true) throw new Error('Invalid SSO enable/HTTPS configuration');
  if (!Array.isArray(config.allowedDomains) || (config.enabled && !config.allowedDomains.length)) throw new Error('SSO requires allowed domains');
  config.allowedDomains = config.allowedDomains.map(normalizeDomain);
  if (!Number.isInteger(config.accessTtlSeconds) || config.accessTtlSeconds < 60 || config.accessTtlSeconds > 3600) throw new Error('SSO TTL must be 60-3600 seconds');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30000) throw new Error('Invalid SSO timeout');
  if (!Array.isArray(config.allowedOrigins) || (config.enabled && !config.allowedOrigins.length)) throw new Error('SSO requires exact allowed origins');
  for (const origin of config.allowedOrigins) {
    if (typeof origin !== 'string') throw new Error('Invalid SSO allowed origin');
    const url = new URL(origin);
    if (origin.includes('*') || url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
      || (config.requireHttps && url.protocol !== 'https:')) throw new Error('Invalid SSO allowed origin');
  }
  return config;
}
