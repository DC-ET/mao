import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { URL } from 'node:url';
import type { LookupFunction } from 'node:net';

/** Weixin CDN requires the RSA-KEX cipher AES256-GCM-SHA384. */
const WEIXIN_CIPHERS = [
  'AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'HIGH',
].join(':');

const ipv4Lookup: LookupFunction = (hostname, _options, callback) => {
  dnsLookup(hostname, { family: 4 }, (err, address, family) => {
    callback(err, address as string, family);
  });
};

export function createWeixinHttpsAgent(timeoutMs = 60_000): https.Agent {
  return new https.Agent({
    keepAlive: true,
    family: 4,
    lookup: ipv4Lookup,
    ciphers: WEIXIN_CIPHERS,
    minVersion: 'TLSv1.2',
    timeout: timeoutMs,
  });
}

export function createWeixinHttpAgent(timeoutMs = 60_000): http.Agent {
  return new http.Agent({
    keepAlive: true,
    family: 4,
    lookup: ipv4Lookup,
    timeout: timeoutMs,
  });
}

export interface WeixinHttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  timeoutMs?: number;
  httpsAgent?: https.Agent;
  httpAgent?: http.Agent;
  signal?: AbortSignal;
}

export interface WeixinHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  header(name: string): string | undefined;
}

export interface WeixinHttpClient {
  request(url: string, init?: WeixinHttpRequestInit): Promise<WeixinHttpResponse>;
}

function headerOf(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const v = headers[key];
  return Array.isArray(v) ? v[0] : v;
}

export function createWeixinHttpClient(defaultTimeoutMs = 60_000): WeixinHttpClient {
  const httpsAgent = createWeixinHttpsAgent(defaultTimeoutMs);
  const httpAgent = createWeixinHttpAgent(defaultTimeoutMs);
  return {
    request(url, init = {}) {
      return weixinRequest(url, {
        ...init,
        timeoutMs: init.timeoutMs ?? defaultTimeoutMs,
        httpsAgent: init.httpsAgent ?? httpsAgent,
        httpAgent: init.httpAgent ?? httpAgent,
      });
    },
  };
}

export function weixinRequest(url: string, init: WeixinHttpRequestInit = {}): Promise<WeixinHttpResponse> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const timeoutMs = init.timeoutMs ?? 60_000;
  const method = init.method ?? (init.body != null ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const body = init.body;
  if (body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
    headers['Content-Length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        agent: isHttps ? (init.httpsAgent ?? createWeixinHttpsAgent(timeoutMs)) : (init.httpAgent ?? createWeixinHttpAgent(timeoutMs)),
        family: 4,
        lookup: ipv4Lookup,
        timeout: timeoutMs,
        ciphers: isHttps ? WEIXIN_CIPHERS : undefined,
        minVersion: isHttps ? 'TLSv1.2' : undefined,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { chunks.push(c); });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
            header: (name) => headerOf(res.headers, name),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
      }, { once: true });
    }
    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}
