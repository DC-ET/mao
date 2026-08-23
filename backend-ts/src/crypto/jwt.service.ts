import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';

export type JwtTokenType = 'access' | 'refresh' | 'shell';

const TOKEN_TYPES: readonly JwtTokenType[] = ['access', 'refresh', 'shell'];

export class JwtService {
  constructor(
    private readonly secret: string,
    private readonly expiration: number,
    private readonly refreshExpiration: number,
    private readonly shellExpiration: number,
  ) {}

  generateToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.expiration, 'access');
  }

  generateRefreshToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.refreshExpiration, 'refresh');
  }

  generateShellToken(userId: number, username: string): string {
    return this.buildToken(userId, username, this.shellExpiration, 'shell');
  }

  private buildToken(userId: number, username: string, expMs: number, type: JwtTokenType): string {
    const key = Buffer.from(this.secret, 'utf8');
    const nowSec = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { username, type },
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

  /** 令牌类型；签名无效返回 null，类型缺失（旧令牌）按 null 处理。 */
  getTokenType(token: string): JwtTokenType | null {
    try {
      const type = this.parseClaims(token).type;
      return TOKEN_TYPES.includes(type as JwtTokenType) ? (type as JwtTokenType) : null;
    } catch {
      return null;
    }
  }

  /** REST/WS 鉴权入口使用：接受 access 与 shell（MAO_TOKEN），拒绝把 refresh 当访问凭据。 */
  validateAccessToken(token: string): boolean {
    const type = this.getTokenType(token);
    return type === 'access' || type === 'shell';
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
