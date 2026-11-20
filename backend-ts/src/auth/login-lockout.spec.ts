import { describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import { registerAuthRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { loginLockKey, LoginLockout } from './login-lockout.js';
import type { LdapAuthService } from './ldap-auth.service.js';
import type { PasswordHasher, User, UserRepository } from '../user/types.js';

describe('LoginLockout', () => {
  it('locksAfterThresholdAndReportsRemainingSeconds', () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ maxFailures: 3, lockMinutes: 15, now: () => now });
    const key = loginLockKey('alice', '1.2.3.4');
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
    lockout.recordFailure(key);
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
    lockout.recordFailure(key);
    const remaining = lockout.lockedSecondsRemaining(key);
    expect(remaining).toBeGreaterThan(0);
    // 第 1 次失败在窗口起点：剩余时长略小于整个窗口
    expect(remaining).toBeLessThanOrEqual(15 * 60);
    expect(remaining).toBeGreaterThanOrEqual(15 * 60 - 5);
  });

  it('unlocksWhenWindowExpires', () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ maxFailures: 2, lockMinutes: 15, now: () => now });
    const key = loginLockKey('alice', '1.2.3.4');
    lockout.recordFailure(key);
    now += 1_000;
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBeGreaterThan(0);
    // 两次失败都滑出窗口后解锁
    now += 15 * 60_000;
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
    // 解锁后可重新计数
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
  });

  it('lockUnlocksExactlyWhenOldestFailureExitsWindow', () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ maxFailures: 3, lockMinutes: 10, now: () => now });
    const key = loginLockKey('alice', '1.2.3.4');
    lockout.recordFailure(key);
    now += 2 * 60_000;
    lockout.recordFailure(key);
    now += 2 * 60_000;
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBeGreaterThan(0);
    // 最早一次失败滑出窗口（还剩 2 次 < 3）→ 解锁
    now += 6 * 60_000 + 1;
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
  });

  it('recordSuccessClearsCount', () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ maxFailures: 2, lockMinutes: 15, now: () => now });
    const key = loginLockKey('alice', '1.2.3.4');
    lockout.recordFailure(key);
    lockout.recordSuccess(key);
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
  });

  it('disabledWhenMaxFailuresIsZero', () => {
    const lockout = new LoginLockout({ maxFailures: 0, lockMinutes: 15, now: () => 1_000_000 });
    const key = loginLockKey('alice', '1.2.3.4');
    for (let i = 0; i < 10; i++) lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
  });

  it('keyNormalizesUsernameAndKeepsIpDistinct', () => {
    expect(loginLockKey('Alice ', '1.2.3.4')).toBe(loginLockKey('alice', '1.2.3.4'));
    expect(loginLockKey('alice', '1.2.3.4')).not.toBe(loginLockKey('alice', '5.6.7.8'));
    expect(loginLockKey('alice', undefined)).toBe('alice|');
  });

  it('cleanupDropsExpiredKeys', () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ maxFailures: 2, lockMinutes: 15, now: () => now });
    lockout.recordFailure(loginLockKey('alice', '1.2.3.4'));
    lockout.recordFailure(loginLockKey('bob', '1.2.3.4'));
    now += 15 * 60_000 + 1_000;
    lockout.recordFailure(loginLockKey('carol', '1.2.3.4'));
    lockout.cleanup();
    expect(lockout.lockedSecondsRemaining(loginLockKey('alice', '1.2.3.4'))).toBe(0);
    expect(lockout.lockedSecondsRemaining(loginLockKey('bob', '1.2.3.4'))).toBe(0);
    expect(lockout.lockedSecondsRemaining(loginLockKey('carol', '1.2.3.4'))).toBe(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('readsThresholdFromEnv', () => {
    vi.stubEnv('LOGIN_MAX_FAILURES', '2');
    vi.stubEnv('LOGIN_LOCK_MINUTES', '7');
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const key = loginLockKey('alice', '1.2.3.4');
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBe(0);
    lockout.recordFailure(key);
    expect(lockout.lockedSecondsRemaining(key)).toBeLessThanOrEqual(7 * 60);
  });
});

describe('AuthService 登录失败锁定', () => {
  function buildService(lockout: LoginLockout | null) {
    const userRepo: UserRepository = {
      findById: vi.fn(),
      findByUsername: vi.fn(),
      countByUsername: vi.fn(),
      countByEmailExcept: vi.fn(),
      insert: vi.fn(),
      updateById: vi.fn(),
      updateFields: vi.fn(),
      selectPage: vi.fn(),
    };
    const jwtService = {
      generateToken: vi.fn(() => 'access'),
      generateRefreshToken: vi.fn(() => 'refresh'),
      validateToken: vi.fn(),
      getTokenType: vi.fn(() => 'refresh'),
      getUserIdFromToken: vi.fn(),
      getUsernameFromToken: vi.fn(),
    } as unknown as JwtService;
    const hasher: PasswordHasher = { hash: vi.fn(), matches: vi.fn() };
    const ldap = {
      isConfigured: vi.fn(async () => false),
      authenticate: vi.fn(),
    } as unknown as LdapAuthService;
    const service = new AuthService(userRepo, jwtService, hasher, ldap, undefined, async () => true, lockout);
    return { service, userRepo, hasher, ldap };
  }

  function localUser(id: number, username: string, hash: string | null, status: number): User {
    return { id, username, passwordHash: hash, status };
  }

  it('locksLoginAfterRepeatedWrongPasswordsAndSkipsLookupWhileLocked', async () => {
    const { service, userRepo } = buildService(new LoginLockout({ maxFailures: 3, lockMinutes: 15 }));
    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    const ip = '9.9.9.9';
    for (let i = 0; i < 3; i++) {
      await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toThrow(/用户名或密码错误/);
    }
    // 第 4 次：锁定直接拒绝，不再查库验密
    await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toThrow(/登录失败次数过多，请约 \d+ 分钟后再试/);
    expect(userRepo.findByUsername).toHaveBeenCalledTimes(3);
    // 锁定的是 用户名+IP 组合：换 IP 不受影响
    await expect(service.login('alice', 'wrong', { clientIp: '8.8.8.8' })).rejects.toThrow(/用户名或密码错误/);
  });

  it('correctPasswordResetsFailureCount', async () => {
    const { service, userRepo, hasher } = buildService(new LoginLockout({ maxFailures: 3, lockMinutes: 15 }));
    const u = localUser(1, 'alice', 'hash', 1);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(u);
    vi.mocked(hasher.matches).mockImplementation(async (password: string) => password === 'right');
    const ip = '9.9.9.9';
    await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    await service.login('alice', 'right', { clientIp: ip });
    await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    // 前后共 4 次失败但中间成功过一次：未达阈值，仍可登录
    await service.login('alice', 'right', { clientIp: ip });
  });

  it('disabledAccountWithCorrectPasswordDoesNotCountAsFailure', async () => {
    const { service, userRepo, hasher } = buildService(new LoginLockout({ maxFailures: 3, lockMinutes: 15 }));
    const disabled = localUser(2, 'bob', 'hash', 0);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(disabled);
    vi.mocked(hasher.matches).mockResolvedValue(true);
    const ip = '9.9.9.9';
    await expect(service.login('bob', 'right', { clientIp: ip })).rejects.toThrow(/账号已被禁用/);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    vi.mocked(hasher.matches).mockResolvedValue(false);
    await expect(service.login('bob', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    await expect(service.login('bob', 'wrong', { clientIp: ip })).rejects.toBeInstanceOf(BusinessException);
    // 禁用账号的正确密码没有计入失败：这里才是第 3 次，仍未锁定
    await expect(service.login('bob', 'wrong', { clientIp: ip })).rejects.toThrow(/用户名或密码错误/);
  });

  it('switchClosedRejectionDoesNotCountAsFailure', async () => {
    const userRepo: UserRepository = {
      findById: vi.fn(),
      findByUsername: vi.fn(),
      countByUsername: vi.fn(),
      countByEmailExcept: vi.fn(),
      insert: vi.fn(),
      updateById: vi.fn(),
      updateFields: vi.fn(),
      selectPage: vi.fn(),
    };
    const jwtService = {
      generateToken: vi.fn(() => 'access'),
      generateRefreshToken: vi.fn(() => 'refresh'),
      validateToken: vi.fn(),
      getTokenType: vi.fn(() => 'refresh'),
      getUserIdFromToken: vi.fn(),
      getUsernameFromToken: vi.fn(),
    } as unknown as JwtService;
    const hasher: PasswordHasher = { hash: vi.fn(), matches: vi.fn() };
    const ldap = {
      isConfigured: vi.fn(async () => false),
      authenticate: vi.fn(),
    } as unknown as LdapAuthService;
    const service = new AuthService(
      userRepo, jwtService, hasher, ldap, undefined,
      async () => false,
      new LoginLockout({ maxFailures: 3, lockMinutes: 15 }),
    );
    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    const ip = '9.9.9.9';
    // 开关关闭的拒绝不是密码尝试：反复多次也不锁
    for (let i = 0; i < 6; i++) {
      await expect(service.login('alice', 'wrong', { clientIp: ip })).rejects.toThrow(/账号密码登录已关闭/);
    }
    expect(userRepo.findByUsername).not.toHaveBeenCalled();
  });

  it('ldapFailureCountsAndLdapSuccessClears', async () => {
    const { service, userRepo, hasher, ldap } = buildService(new LoginLockout({ maxFailures: 2, lockMinutes: 15 }));
    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    vi.mocked(hasher.matches).mockResolvedValue(false);
    vi.mocked(ldap.isConfigured).mockResolvedValue(true);
    vi.mocked(ldap.authenticate).mockRejectedValue(new Error('bad credentials'));
    const ip = '9.9.9.9';
    // LDAP 失败与本地失败同口径计数
    await expect(service.login('alice', 'x', { clientIp: ip })).rejects.toThrow(/用户名或密码错误/);
    // LDAP 成功视为正确密码：清零计数
    vi.mocked(ldap.authenticate).mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 1, user: { username: 'alice' } });
    await service.login('alice', 'x', { clientIp: ip });
    // 清零后重新累计：两次失败（第二次达到阈值）后才在下一次锁定
    vi.mocked(ldap.authenticate).mockRejectedValue(new Error('bad credentials'));
    await expect(service.login('alice', 'x', { clientIp: ip })).rejects.toThrow(/用户名或密码错误/);
    await expect(service.login('alice', 'x', { clientIp: ip })).rejects.toThrow(/用户名或密码错误/);
    await expect(service.login('alice', 'x', { clientIp: ip })).rejects.toThrow(/登录失败次数过多/);
  });

  it('noLockoutInjectedKeepsLegacyBehavior', async () => {
    const { service, userRepo } = buildService(null);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    for (let i = 0; i < 10; i++) {
      await expect(service.login('alice', 'wrong', { clientIp: '9.9.9.9' })).rejects.toThrow(/用户名或密码错误/);
    }
  });
});

describe('auth routes 传递 clientIp', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('bothLoginRoutesPassRequestIpAsClientIp', async () => {
    const app = Fastify();
    const login = vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 1, user: {} }));
    const auth = {
      login,
      passwordLoginEnabled: vi.fn(async () => true),
    } as unknown as AuthService;
    const feishuStub = { isEnabled: vi.fn(async () => false), getQrCodeUrl: vi.fn(), handleCallback: vi.fn(), renderCallbackPage: vi.fn(), getLoginStatus: vi.fn() };
    const ecpStub = { isEnabled: vi.fn(async () => false) };
    registerAuthRoutes(app, auth, feishuStub as never, ecpStub as never);
    await app.ready();
    await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'alice', password: 'p' } });
    await app.inject({ method: 'POST', url: '/v1/auth/admin/login', payload: { username: 'alice', password: 'p' } });
    expect(login).toHaveBeenCalledTimes(2);
    expect(login.mock.calls[0]?.[2]).toEqual({ clientIp: '127.0.0.1' });
    expect(login.mock.calls[1]?.[2]).toEqual({ ignorePasswordSwitch: true, clientIp: '127.0.0.1' });
    await app.close();
  });
});
