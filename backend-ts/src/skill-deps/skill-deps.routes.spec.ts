import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerSkillDepsRoutes } from './skill-deps.routes.js';
import { SkillDepsService } from './skill-deps.service.js';

function buildApp(granted: string[]) {
  const install = vi.fn(async () => ({ started: true }));
  const service = new SkillDepsService([
    {
      skillName: 'browser-use',
      status: async () => [{ id: 'browser', label: '浏览器依赖', kind: 'install', phase: 'not_installed', detail: null }],
      install,
    },
    {
      skillName: 'lark-cli',
      status: async () => [{ id: 'ecp', label: '飞书凭证', kind: 'config', phase: 'not_installed', detail: null, text: '未配置', action: { label: '去配置', route: '/settings' } }],
    },
  ]);
  const permissionService = { hasPermission: vi.fn(async (_uid: number, code: string) => granted.includes(code)) };
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => { (req as { userId?: number }).userId = 7; done(); });
  registerSkillDepsRoutes(app, { service, permissionService });
  return { app, install };
}

describe('skill-deps routes', () => {
  it('status 需要 skill:read，返回按技能名键控的聚合结构', async () => {
    const denied = buildApp([]).app;
    expect((await denied.inject({ method: 'GET', url: '/v1/admin/skill-deps/status' })).statusCode).toBe(403);

    const { app } = buildApp(['skill:read']);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/skill-deps/status' });
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(Object.keys(body.data.skills).sort()).toEqual(['browser-use', 'lark-cli']);
    expect(body.data.skills['browser-use'].items[0]).toMatchObject({ kind: 'install', phase: 'not_installed' });
    expect(body.data.skills['lark-cli'].items[0].action).toEqual({ label: '去配置', route: '/settings' });
  });

  it('install 需要 skill:write，按技能派发', async () => {
    const readonly = buildApp(['skill:read']);
    const denied = await readonly.app.inject({ method: 'POST', url: '/v1/admin/skill-deps/browser-use/install' });
    expect(denied.statusCode).toBe(403);
    expect(readonly.install).not.toHaveBeenCalled();

    const { app, install } = buildApp(['skill:write']);
    const res = await app.inject({ method: 'POST', url: '/v1/admin/skill-deps/browser-use/install' });
    expect(JSON.parse(res.body)).toMatchObject({ code: 0, data: { started: true } });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('未知技能与 config 类技能的 install 返回业务错误', async () => {
    const { app } = buildApp(['skill:write']);
    const unknown = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/skill-deps/nope/install' })).body);
    expect(unknown.code).toBe(ErrorCode.SKILL_NOT_FOUND.code);
    const config = JSON.parse((await app.inject({ method: 'POST', url: '/v1/admin/skill-deps/lark-cli/install' })).body);
    expect(config.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(config.message).toContain('配置');
  });
});
