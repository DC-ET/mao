import { describe, expect, it } from 'vitest';
import { hashPassword, matchesPassword } from './password.js';

describe('password', () => {
  it('hashes with bcrypt $2a/$2b cost 10 and verifies', async () => {
    const hash = await hashPassword('admin123');
    expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);
    expect(await matchesPassword('admin123', hash)).toBe(true);
    expect(await matchesPassword('wrong', hash)).toBe(false);
  });

  it('verifies a Spring BCryptPasswordEncoder hash', async () => {
    // Spring Security BCrypt.hashpw("password", BCrypt.gensalt()) — $2a$ cost 10
    const springHash = '$2a$10$cWncS4/EmZtzM./4V/o1S.Z9NaCc5n9FAWDm/RTQwN83QKpOAo9r2';
    expect(await matchesPassword('password', springHash)).toBe(true);
  });
});
