import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import {
  FEISHU_FAILED,
  FEISHU_PENDING,
  FEISHU_SUCCESS,
  FeishuAuthService,
  type FeishuHttp,
  type FeishuOauthStateRepository,
} from './feishu-auth.service.js';
import type { UserRepository, UserRoleRepository } from '../user/types.js';

const jwt = new JwtService('mao-dev-jwt-secret-change-me-32bytes!!', 86400000, 604800000, 7200000);

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    appId: 'app-id',
    appSecret: 'secret',
    redirectUri: 'http://localhost:9080/api/v1/auth/feishu/callback',
    authorizeUrl: 'https://open.feishu.test/authorize',
    tokenUrl: 'https://open.feishu.test/token',
    userInfoUrl: 'https://open.feishu.test/user',
    appTokenUrl: 'https://open.feishu.test/app-token',
    ...overrides,
  };
}

function makeService(http?: FeishuHttp) {
  const userRepo = {
    insert: vi.fn(async (u: { id?: number }) => { u.id = 8; return 8; }),
    updateById: vi.fn(),
    findById: vi.fn(),
    findByUsername: vi.fn(async () => null),
    findByEmail: vi.fn(async () => null),
    findByFeishuUserId: vi.fn(async () => null),
  };
  const userRoleRepo = { insert: vi.fn() };
  const stateRepo = {
    insert: vi.fn(),
    findByState: vi.fn(),
    updateByState: vi.fn(async () => 1),
    consumeSuccess: vi.fn(async () => 1),
  };
  const service = new FeishuAuthService(
    userRepo as unknown as UserRepository,
    userRoleRepo as unknown as UserRoleRepository,
    stateRepo as unknown as FeishuOauthStateRepository,
    jwt,
    cfg() as never,
    http ?? { postJson: vi.fn(), getJson: vi.fn() },
  );
  return { service, userRepo, userRoleRepo, stateRepo };
}

describe('FeishuAuthService', () => {
  it('qrcodeRejectsUnconfiguredApp', async () => {
    const { userRepo, userRoleRepo, stateRepo } = makeService();
    const service = new FeishuAuthService(
      userRepo as never, userRoleRepo as never, stateRepo as never, jwt, cfg({ appId: '' }) as never,
    );
    await expect(service.getQrCodeUrl()).rejects.toBeInstanceOf(BusinessException);
  });

  it('qrcodeRejectsDisabledLogin', async () => {
    const { userRepo, userRoleRepo, stateRepo } = makeService();
    const service = new FeishuAuthService(
      userRepo as never, userRoleRepo as never, stateRepo as never, jwt, cfg({ enabled: false }) as never,
    );
    await expect(service.getQrCodeUrl()).rejects.toBeInstanceOf(BusinessException);
  });

  it('qrcodeCreatesStateAndReturnsAuthorizeUrl', async () => {
    const { service, stateRepo } = makeService();
    const vo = await service.getQrCodeUrl();
    expect(stateRepo.insert).toHaveBeenCalled();
    expect(vo.authUrl).toContain('https://open.feishu.test/authorize');
    expect(vo.state).toBeTruthy();
    expect(vo.expiresIn).toBe(300);
  });

  it('isEnabledRequiresRealAppId', () => {
    const { service } = makeService();
    expect(service.isEnabled()).toBe(true);
  });

  it('completeStateWithCodeCreatesUserAndPollReturnsLogin', async () => {
    const http: FeishuHttp = {
      postJson: vi.fn(async (url: string) => {
        if (url.includes('app-token')) return { ok: true, json: { code: 0, app_access_token: 'app' } };
        return { ok: true, json: { code: 0, data: { access_token: 'user' } } };
      }),
      getJson: vi.fn(async () => ({
        ok: true,
        json: { code: 0, data: { name: 'Li', email: 'li@example.com', user_id: 'fu-1', avatar_url: 'http://a' } },
      })),
    };
    const { service, stateRepo, userRepo } = makeService(http);
    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'st', status: FEISHU_PENDING, expiresAt: '2099-01-01 00:00:00',
    });
    await service.completeStateWithCode('st', 'code-1');
    expect(userRepo.insert).toHaveBeenCalled();
    expect(stateRepo.updateByState).toHaveBeenCalled();

    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'st', status: FEISHU_SUCCESS, userId: 8, expiresAt: '2099-01-01 00:00:00',
    });
    vi.mocked(userRepo.findById).mockResolvedValue({
      id: 8, username: 'li', displayName: 'Li', email: 'li@example.com', feishuUserId: 'fu-1', status: 1,
    });
    const status = await service.getLoginStatus('st');
    expect(status.status).toBe(FEISHU_SUCCESS);
    expect((status as { login?: { accessToken: string } }).login?.accessToken).toBeTruthy();
  });

  it('getLoginStatusHandlesMissingExpiredAndDisabled', async () => {
    const { service, stateRepo } = makeService();
    expect((await service.getLoginStatus(''))).toMatchObject({ status: FEISHU_FAILED });
    vi.mocked(stateRepo.findByState).mockResolvedValue(null);
    expect((await service.getLoginStatus('x'))).toMatchObject({ status: FEISHU_FAILED });
    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'x', status: FEISHU_PENDING, expiresAt: '2000-01-01 00:00:00',
    });
    const expired = await service.getLoginStatus('x');
    expect(expired.status).toBe('EXPIRED');
  });

  it('renderCallbackPageReturnsHtml', async () => {
    const { service, stateRepo } = makeService();
    vi.mocked(stateRepo.findByState).mockResolvedValue(null);
    const html = await service.renderCallbackPage('missing', 'code');
    expect(html).toContain('登录失败');
  });
});
