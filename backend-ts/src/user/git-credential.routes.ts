import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { GitCredential, GitCredentialService } from './git-credential.service.js';

export function registerGitCredentialRoutes(app: FastifyInstance, service: GitCredentialService): void {
  app.get('/v1/user/git-credentials', async (request, reply) => {
    const userId = requireUserId(request);
    const list = await service.listByUserId(userId);
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/user/git-credentials', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ domain?: string; accessToken?: string; description?: string }>(request);
    const created = await service.create(userId, body.domain ?? '', body.accessToken ?? '', body.description);
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/user/git-credentials/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ accessToken?: string; description?: string }>(request);
    const updated = await service.update(userId, pathId(request), body.accessToken, body.description);
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/user/git-credentials/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await service.delete(userId, pathId(request));
    return sendOk(reply);
  });
}

export interface AdminGitCredentialRouteDeps {
  gitCredentialService: GitCredentialService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/** 管理端：以用户视角查看/删除 Git 凭证（token 始终脱敏，不透出明文）。 */
export function registerAdminGitCredentialRoutes(app: FastifyInstance, deps: AdminGitCredentialRouteDeps): void {
  const { gitCredentialService, permissionService } = deps;

  app.get('/v1/admin/users/:id/git-credentials', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'user:read');
    const list = await gitCredentialService.listByUserId(pathId(request));
    return sendOk(reply, list.map(toVO));
  });

  app.delete('/v1/admin/users/:id/git-credentials/:credentialId', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'user:write');
    const credentialId = Number((request.params as { credentialId: string }).credentialId);
    await gitCredentialService.deleteByAdmin(credentialId, pathId(request));
    return sendOk(reply);
  });
}

function toVO(credential: GitCredential) {
  return {
    id: credential.id,
    domain: credential.domain,
    accessToken: '****',
    description: credential.description,
    createdAt: credential.createdAt != null ? String(credential.createdAt).replace(' ', 'T') : null,
    updatedAt: credential.updatedAt != null ? String(credential.updatedAt).replace(' ', 'T') : null,
  };
}
