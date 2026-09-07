import type { FastifyRequest } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';

/** Restrict only the exchange endpoint; preserve the existing REST CORS policy. */
export function corsForRequest(
  request: FastifyRequest,
  exchangePath: string,
  enabled: boolean,
  allowedOrigins: readonly string[],
): FastifyCorsOptions {
  const isExchange = request.url.split('?')[0] === exchangePath;
  const origin = request.headers.origin;
  return {
    origin: isExchange ? enabled && typeof origin === 'string' && allowedOrigins.includes(origin) : true,
    credentials: !isExchange,
    methods: isExchange ? ['POST', 'OPTIONS'] : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Requested-With'],
    exposedHeaders: isExchange ? ['Retry-After'] : [],
    maxAge: 3600,
  };
}
