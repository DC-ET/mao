import type { FastifyInstance } from 'fastify';
import { requireUserId, sendOk } from '../common/http-error.js';
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
