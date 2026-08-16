import { describe, expect, it } from 'vitest';
import { JwtService } from './jwt.service.js';

describe('JwtService', () => {
  const secret = 'mao-dev-jwt-secret-change-me-32bytes!!';
  const svc = new JwtService(secret, 86400000, 604800000, 7200000);

  it('issues and validates tokens with Java-compatible claims', () => {
    const token = svc.generateToken(42, 'alice');
    expect(svc.validateToken(token)).toBe(true);
    expect(svc.getUserIdFromToken(token)).toBe(42);
    expect(svc.getUsernameFromToken(token)).toBe('alice');
  });

  it('refresh and shell tokens validate', () => {
    expect(svc.validateToken(svc.generateRefreshToken(1, 'a'))).toBe(true);
    expect(svc.validateToken(svc.generateShellToken(1, 'a'))).toBe(true);
  });

  it('rejects garbage tokens', () => {
    expect(svc.validateToken('not-a-jwt')).toBe(false);
  });

  it('rejects expired tokens', () => {
    const short = new JwtService(secret, 1, 1, 1);
    const token = short.generateToken(1, 'x');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(short.validateToken(token)).toBe(false);
        resolve();
      }, 20);
    });
  });
});
