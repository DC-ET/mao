import type { FastifyRequest } from 'fastify';
import type { JwtService } from '../crypto/jwt.service.js';

const PUBLIC_PREFIXES = ['/v1/auth', '/swagger-ui', '/v3/api-docs', '/ws/'];

export function isPublicPath(method: string, rawUrl: string): boolean {
  const path = rawUrl.split('?')[0].replace(/^\/api/, '') || '/';
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    return true;
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/uploads/')) {
    return true;
  }
  return false;
}

export function resolveToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  const query = request.query as Record<string, string | undefined>;
  if (query?.token) {
    return query.token;
  }
  return null;
}

export function authenticateRequest(request: FastifyRequest, jwt: JwtService): number | null {
  const token = resolveToken(request);
  if (!token || !jwt.validateAccessToken(token)) {
    return null;
  }
  return jwt.getUserIdFromToken(token);
}
