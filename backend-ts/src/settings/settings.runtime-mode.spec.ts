import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { handleError } from '../common/http-error.js';
import { RUNTIME_MODE_SETTING_KEY, validateRuntimeModeSave } from '../harness/container/runtime-mode.js';
import { registerSystemSettingRoutes } from './settings.routes.js';
import { SystemSettingService } from './settings.service.js';
import type { SystemSetting, SystemSettingRepository } from './types.js';

function fixture() {
  const row: SystemSetting = {
    id: 1, settingKey: RUNTIME_MODE_SETTING_KEY, value: 'host',
    category: '运行环境', description: '运行时模式', editable: 1, isSecret: 0,
  };
  const repo: SystemSettingRepository = {
    list: vi.fn(async () => [{ ...row }]),
    findByKey: vi.fn(async (key) => (key === row.settingKey ? { ...row } : null)),
    updateById: vi.fn(async (next) => { row.value = next.value; }),
    transaction: vi.fn(async (fn) => fn(repo)),
  };
  const settings = new SystemSettingService(
    repo,
    { findById: async () => null },
    { findById: async () => null },
    { workspaceRoot: '', skillsDir: '' },
  );
  return { settings, repo };
}

async function application(hooks: {
  beforeSave?: (items: Array<{ key: string; value: string | null }>) => Promise<void>;
  afterSave?: (keys: string[]) => void;
}) {
  const { settings, repo } = fixture();
  const app = Fastify();
  app.setErrorHandler(handleError);
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => { (request as { userId?: number }).userId = 1; });
    registerSystemSettingRoutes(api, {
      systemSettingService: settings,
      permissionService: { hasPermission: async () => true },
      ...hooks,
    });
  }, { prefix: '/api' });
  return { app, repo };
}

describe('system settings runtime mode save hooks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects the write when beforeSave throws and keeps the stored value', async () => {
    const beforeSave = vi.fn(async () => {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '容器运行时预检失败，未保存：镜像不存在');
    });
    const { app, repo } = await application({ beforeSave });
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/system-settings/runtime.mode', payload: { value: 'docker' },
    });
    expect(JSON.parse(res.body).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(beforeSave).toHaveBeenCalledWith([{ key: RUNTIME_MODE_SETTING_KEY, value: 'docker' }]);
    expect(repo.updateById).not.toHaveBeenCalled();
  });

  it('runs afterSave with the written keys on the batch path', async () => {
    const afterSave = vi.fn();
    const { app, repo } = await application({ afterSave });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/system-settings/batch',
      payload: { items: [{ key: RUNTIME_MODE_SETTING_KEY, value: 'docker' }] },
    });
    expect(JSON.parse(res.body).code).toBe(0);
    expect(repo.updateById).toHaveBeenCalled();
    expect(afterSave).toHaveBeenCalledWith([RUNTIME_MODE_SETTING_KEY]);
  });
});

describe('validateRuntimeModeSave', () => {
  it('skips activation for host / empty values and activates for docker', async () => {
    const activate = vi.fn(async () => undefined);
    expect(await validateRuntimeModeSave([{ key: RUNTIME_MODE_SETTING_KEY, value: 'host' }], activate)).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(await validateRuntimeModeSave([{ key: RUNTIME_MODE_SETTING_KEY, value: null }], activate)).toBe(false);
    expect(await validateRuntimeModeSave([{ key: 'workspace.root', value: 'docker' }], activate)).toBe(false);
    expect(await validateRuntimeModeSave([{ key: RUNTIME_MODE_SETTING_KEY, value: 'DOCKER' }], activate)).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown values and precheck failures', async () => {
    await expect(validateRuntimeModeSave(
      [{ key: RUNTIME_MODE_SETTING_KEY, value: 'container' }],
      async () => undefined,
    )).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    await expect(validateRuntimeModeSave(
      [{ key: RUNTIME_MODE_SETTING_KEY, value: 'docker' }],
      async () => { throw new Error('镜像 mao-runtime:latest 不存在'); },
    )).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });
});
