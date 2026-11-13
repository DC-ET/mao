import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { GitCredentialService } from './git-credential.service.js';
import type { SystemGitCredential, SystemGitCredentialService } from './system-git-credential.service.js';

export interface SystemGitCredentialRouteDeps {
  systemGitCredentialService: SystemGitCredentialService;
  /** /v1/admin/git-domains 的用户侧域并集来源（只取 DISTINCT domain，不解密）。 */
  gitCredentialService: Pick<GitCredentialService, 'listAllDomains'>;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * 系统默认 Git 凭据（技术方案 2026-11-12 §5.4）：
 * 管理端 CRUD 挂 settings:read/write（面板归属「系统设置」），全站域枚举挂 agent:read（Agent 表单候选）；
 * 用户端只读默认域清单供桌面「系统默认」灰行展示。管理端路由经 /v1/admin 前缀自动进审计拦截器。
 */
export function registerSystemGitCredentialRoutes(app: FastifyInstance, deps: SystemGitCredentialRouteDeps): void {
  const { systemGitCredentialService, gitCredentialService, permissionService } = deps;

  app.get('/v1/admin/git-default-credentials', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:read');
    const list = await systemGitCredentialService.list();
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/admin/git-default-credentials', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    const body = bodyOf<{ domain?: string; accessToken?: string; description?: string }>(request);
    const created = await systemGitCredentialService.create(body.domain ?? '', body.accessToken ?? '', body.description);
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/admin/git-default-credentials/:id', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    const body = bodyOf<{ accessToken?: string; description?: string }>(request);
    const updated = await systemGitCredentialService.update(pathId(request), body.accessToken, body.description);
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/admin/git-default-credentials/:id', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    await systemGitCredentialService.delete(pathId(request));
    return sendOk(reply);
  });

  // 全站域枚举（技术方案 D4，替代 2026-11-06 的「管理员个人凭证域」候选口径）：
  // 用户凭据域 ∪ 系统默认域，仅回域名（无 Token、无用户归属），由 agent:read 守门。
  app.get('/v1/admin/git-domains', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'agent:read');
    const [userDomains, systemDomains] = await Promise.all([
      gitCredentialService.listAllDomains(),
      systemGitCredentialService.listDomains(),
    ]);
    const domains = [...new Set([...userDomains, ...systemDomains])].sort((a, b) => a.localeCompare(b));
    return sendOk(reply, { domains });
  });

  // 用户端「系统默认」灰行数据源：只回域名与备注，不含 Token（桌面端过滤掉用户已配置的域后展示）。
  app.get('/v1/user/git-default-credentials', async (request, reply) => {
    requireUserId(request);
    const list = await systemGitCredentialService.list();
    return sendOk(reply, list.map((item) => ({ domain: item.domain, description: item.description ?? null })));
  });
}

function toVO(credential: SystemGitCredential) {
  return {
    id: credential.id,
    domain: credential.domain,
    accessToken: '****',
    description: credential.description,
    createdAt: credential.createdAt != null ? String(credential.createdAt).replace(' ', 'T') : null,
    updatedAt: credential.updatedAt != null ? String(credential.updatedAt).replace(' ', 'T') : null,
  };
}
