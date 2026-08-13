import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';

export class JwtService {
  constructor(
    private readonly secret: string,
    private readonly expiration: number,
    private readonly refreshExpiration: number,
    private readonly shellExpiration: number,
  ) {}

  generateToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.expiration);
  }

  generateRefreshToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.refreshExpiration);
  }

  generateShellToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.shellExpiration);
  }

  private buildToken(userId: number, username: string, expMs: number): string {
    const key = Buffer.from(this.secret, 'utf8');
    const nowSec = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { username },
      key,
      {
        algorithm: 'HS256',
        subject: String(userId),
        expiresIn: Math.floor(expMs / 1000),
        noTimestamp: false,
      },
    );
    void nowSec;
  }

  getUserIdFromToken(token: string): number {
    return Number(this.parseClaims(token).sub);
  }

  getUsernameFromToken(token: string): string {
    return String(this.parseClaims(token).username);
  }

  validateToken(token: string): boolean {
    try {
      this.parseClaims(token);
      return true;
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) {
        console.warn(`JWT token expired: ${e.message}`);
      } else if (e instanceof Error) {
        console.warn(`JWT token validation error: ${e.constructor.name} - ${e.message}`);
      }
      return false;
    }
  }

  private parseClaims(token: string): jwt.JwtPayload {
    const key = Buffer.from(this.secret, 'utf8');
    const payload = jwt.verify(token, key, { algorithms: ['HS256'] });
    if (typeof payload === 'string') {
      throw new Error('Unexpected JWT payload');
    }
    return payload;
  }
}

/** Used by tests to assert HMAC key bytes match Java `secret.getBytes()`. */
export function hmacSha256(secret: string, data: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(data).digest();
}
