import type { FastifyRequest } from 'fastify';
import { BusinessException } from './business-exception.js';
import { ErrorCode } from './error-code.js';
import { hasText } from './case.js';
import type { JwtService } from '../crypto/jwt.service.js';

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

export function requireUserId(request: FastifyRequest, jwt: JwtService): number {
  const token = extractBearerToken(request);
  if (!hasText(token) || !jwt.validateToken(token!)) {
    throw new BusinessException(ErrorCode.UNAUTHORIZED);
  }
  return jwt.getUserIdFromToken(token!);
}
