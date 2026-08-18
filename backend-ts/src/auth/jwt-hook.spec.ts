import { describe, expect, it } from 'vitest';
import { isPublicPath } from './jwt-hook.js';

describe('jwt-hook public paths', () => {
  it('matches Java SecurityConfig whitelist', () => {
    expect(isPublicPath('POST', '/api/v1/auth/login')).toBe(true);
    expect(isPublicPath('GET', '/api/swagger-ui.html')).toBe(true);
    expect(isPublicPath('GET', '/api/v3/api-docs')).toBe(true);
    expect(isPublicPath('GET', '/api/ws/stream')).toBe(true);
    expect(isPublicPath('GET', '/api/uploads/x')).toBe(true);
    expect(isPublicPath('POST', '/api/v1/users')).toBe(false);
    expect(isPublicPath('GET', '/api/v1/sessions')).toBe(false);
  });
});
