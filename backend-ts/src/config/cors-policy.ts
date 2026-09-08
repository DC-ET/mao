import type { FastifyRequest } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import { companySsoConfigForRequest, type CompanySsoSettings } from '../auth/company-sso-request.js';

/** Restrict only the exchange endpoint; preserve the existing REST CORS policy. */
export async function corsForRequest(
  request: FastifyRequest,
  exchangePath: string,
  settings: CompanySsoSettings,
): Promise<FastifyCorsOptions> {
  const isExchange = request.url.split('?')[0] === exchangePath;
  // Bad stored configuration must fail closed, without breaking unrelated REST requests.
  const config = isExchange ? await companySsoConfigForRequest(request, settings).catch(() => null) : null;
  const origin = request.headers.origin;
  return {
    origin: isExchange ? config?.enabled === true && typeof origin === 'string' && config.allowedOrigins.includes(origin) : true,
    credentials: !isExchange,
    methods: isExchange ? ['POST', 'OPTIONS'] : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Requested-With'],
    exposedHeaders: isExchange ? ['Retry-After'] : [],
    maxAge: 3600,
  };
}
