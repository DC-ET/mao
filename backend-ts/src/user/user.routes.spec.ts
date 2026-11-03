import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerUserRoutes } from './user.routes.js';
import type { UserRepository } from './types.js';
import { UserService } from './user.service.js';
import type { PermissionService } from '../permission/permission.service.js';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

/**
 * 自助改密路由（PUT /v1/users/me/password）：
 * - 登录态即可（不挂 requirePermission）：无 user:write 的普通角色也能改自己的密码；
 * - 两次输入一致性在路由层拒绝（与管理员重置路由同文案）。
 * 断言口径与既有路由 spec 一致：业务异常经 handleError 回 HTTP 200 + envelope code（2001）。
 */
describe('user routes: PUT /v1/users/me/password', () => {
  function application(userService: Pick<UserService, 'changeOwnPassword'>) {
    const changeOwnPassword = vi.fn(userService.changeOwnPassword);
    const permissionService = {
      hasPermission: vi.fn(async () => false),
      getUserPermissionCodes: vi.fn(async () => []),
      isAdmin: vi.fn(async () => false),
    } as unknown as PermissionService;
    const userRepo = {
      findById: vi.fn(async () => ({ id: 7, username: 'alice', passwordHash: 'old-hash' })),
    } as unknown as UserRepository;
    const app = Fastify();
    app.setErrorHandler(handleError);
    void app.register(async (api) => {
      api.addHook('preHandler', async (request) => {
        (request as { userId?: number }).userId = 7;
      });
      registerUserRoutes(api, { changeOwnPassword } as unknown as UserService, userRepo, permissionService);
    }, { prefix: '/api' });
    return { app, changeOwnPassword, permissionService };
  }

  it('普通用户（无 user:write）登录态即可改密：不查权限、透传三参数', async () => {
    const { app, changeOwnPassword, permissionService } = application({ changeOwnPassword: async () => undefined });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/users/me/password', payload: { oldPassword: 'OldPass1', newPassword: 'NewPass2', confirmPassword: 'NewPass2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(0);
    expect(changeOwnPassword).toHaveBeenCalledWith(7, 'OldPass1', 'NewPass2');
    expect(permissionService.hasPermission).not.toHaveBeenCalled();
  });

  it('两次输入不一致 → code 2001「两次输入的密码不一致」，不进 service', async () => {
    const { app, changeOwnPassword } = application({ changeOwnPassword: async () => undefined });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/users/me/password', payload: { oldPassword: 'OldPass1', newPassword: 'NewPass2', confirmPassword: 'Other2' } });
    expect(res.json().code).toBe(2001);
    expect(res.json().message).toBe('两次输入的密码不一致');
    expect(changeOwnPassword).not.toHaveBeenCalled();
  });

  it('缺 newPassword → code 2001，不进 service', async () => {
    const { app, changeOwnPassword } = application({ changeOwnPassword: async () => undefined });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/users/me/password', payload: { oldPassword: 'OldPass1' } });
    expect(res.json().code).toBe(2001);
    expect(res.json().message).toBe('两次输入的密码不一致');
    expect(changeOwnPassword).not.toHaveBeenCalled();
  });

  it('service 业务异常（旧密码不正确）→ code 2001 透传文案', async () => {
    const { app, changeOwnPassword } = application({
      changeOwnPassword: async () => {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '当前密码不正确');
      },
    });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/users/me/password', payload: { oldPassword: 'Wrong1', newPassword: 'NewPass2', confirmPassword: 'NewPass2' } });
    expect(res.json().code).toBe(2001);
    expect(res.json().message).toBe('当前密码不正确');
    expect(changeOwnPassword).toHaveBeenCalledTimes(1);
  });
});
