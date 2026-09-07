import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
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

  it('reads verified access and shell metadata in milliseconds', () => {
    for (const token of [svc.generateToken(42, 'alice'), svc.generateShellToken(42, 'alice')]) {
      const claims = jwt.decode(token) as jwt.JwtPayload;
      expect(svc.getAccessTokenMetadata(token)).toEqual({ userId: 42, expiresAt: claims.exp! * 1000 });
    }
    const exp = Math.floor(Date.now() / 1000) + 1800;
    const token = jwt.sign({ sub: '42', type: 'access', auth_source: 'company_sso', exp }, secret);
    expect(svc.getAccessTokenMetadata(token)).toEqual({ userId: 42, authSource: 'company_sso', expiresAt: exp * 1000 });
  });

  it('fails closed on invalid access metadata', () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    const valid = { sub: '42', type: 'access', exp };
    for (const overrides of [
      { type: 'refresh' }, { type: 'unknown' }, { type: undefined },
      { sub: '0' }, { sub: '-1' }, { sub: '1.5' }, { sub: '01' },
      { sub: '9007199254740992' }, { sub: undefined },
      { exp: undefined }, { exp: exp + 0.5 }, { exp: 1 },
      { exp: Number.MAX_SAFE_INTEGER }, { auth_source: 123 }, { auth_source: '' },
    ]) {
      const claims = Object.fromEntries(Object.entries({ ...valid, ...overrides }).filter(([, value]) => value !== undefined));
      expect(svc.getAccessTokenMetadata(jwt.sign(claims, secret))).toBeNull();
    }
    expect(svc.getAccessTokenMetadata(jwt.sign(valid, 'wrong-secret'))).toBeNull();
    expect(svc.getAccessTokenMetadata(jwt.sign(valid, secret, { algorithm: 'HS384' }))).toBeNull();
    expect(svc.getAccessTokenMetadata('not-a-jwt')).toBeNull();
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
