import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { BrowserDepsService } from './browser-deps.service.js';

/**
 * 浏览器依赖（browser-use 技能）按需安装端点：
 * - GET status（skill:read）：系统技能页依赖状态 tag + 安装进度轮询；
 * - POST install（skill:write）：显式安装（Agent 勾选保存触发的 ensure 走 service 内部，不经此端点）。
 * `/v1/admin` 前缀自动进审计拦截器，无需额外登记。
 */
export function registerBrowserDepsRoutes(
  api: FastifyInstance,
  deps: { service: BrowserDepsService; permissionService: { hasPermission(userId: number, code: string): Promise<boolean> } },
): void {
  api.get('/v1/admin/browser-deps/status', async (req, reply) => {
    const userId = await requireRequestPermission(deps.permissionService, req, 'skill:read');
    void userId;
    const status = await deps.service.getStatus();
    sendJson(reply, 200, ok(status));
  });

  api.post('/v1/admin/browser-deps/install', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'skill:write');
    const result = await deps.service.install();
    sendJson(reply, 200, ok(result));
  });
}
