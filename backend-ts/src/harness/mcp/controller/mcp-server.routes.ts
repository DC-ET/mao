import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../../../common/business-exception.js';
import { requireUserId, sendJson, sendOk } from '../../../common/http-error.js';
import { bodyOf, pathId, queryOptStr } from '../../../common/request.js';
import { fail } from '../../../common/result.js';
import type { McpClientManager } from '../mcp-client-manager.js';
import type { UserMcpPreferenceService } from '../preference/service/user-mcp-preference.service.js';
import type { McpServerService } from '../service/mcp-server.service.js';
import { STATUS_ENABLED, type McpServer } from '../entity/mcp-server.js';

export interface McpServerRouteDeps {
  mcpServerService: McpServerService;
  mcpClientManager: McpClientManager;
  userMcpPreferenceService: UserMcpPreferenceService;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
}

interface PreferenceItem {
  serverId?: number;
  enabled?: boolean;
}

interface SaveMcpPreferencesRequest {
  items?: PreferenceItem[];
}

interface SaveMcpServerRequest {
  name?: string;
  description?: string | null;
  serverType?: string;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
}

interface UpdateStatusRequest {
  status?: string;
}

export function registerMcpServerRoutes(app: FastifyInstance, deps: McpServerRouteDeps): void {
  const { mcpServerService, mcpClientManager, userMcpPreferenceService, permissionService } = deps;

  app.get('/v1/mcp-servers/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    const disabledByUser = await userMcpPreferenceService.getDisabledServerIds(userId);
    const voList: Array<Record<string, unknown>> = [];
    for (const server of await mcpServerService.listEnabled()) {
      voList.push(toPreferenceVo(server, 'GLOBAL', !disabledByUser.includes(server.id!)));
    }
    for (const server of await mcpServerService.listMine(userId)) {
      voList.push(toPreferenceVo(
        server,
        'USER',
        server.status === STATUS_ENABLED && !disabledByUser.includes(server.id!),
      ));
    }
    return sendOk(reply, voList);
  });

  app.put('/v1/mcp-servers/preferences', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<SaveMcpPreferencesRequest>(request);
    if (body.items) {
      for (const item of body.items) {
        if (item.serverId == null) continue;
        await mcpServerService.validatePreferenceTarget(userId, item.serverId);
        await userMcpPreferenceService.save(userId, item.serverId, item.enabled === true);
      }
    }
    return sendOk(reply);
  });

  app.get('/v1/mcp-servers/me', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await mcpServerService.listMine(userId));
  });

  app.post('/v1/mcp-servers/me', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<SaveMcpServerRequest>(request);
    const server = await mcpServerService.createMine(
      userId, body.name ?? '', body.description ?? null, body.serverType ?? '',
      body.command, body.args, body.url, body.env,
    );
    return sendOk(reply, server);
  });

  app.put('/v1/mcp-servers/me/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<SaveMcpServerRequest>(request);
    const server = await mcpServerService.updateMine(
      userId, pathId(request), body.name, body.description, body.serverType,
      body.command, body.args, body.url, body.env,
    );
    return sendOk(reply, server);
  });

  app.delete('/v1/mcp-servers/me/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await mcpServerService.deleteMine(userId, pathId(request));
    return sendOk(reply);
  });

  app.post('/v1/mcp-servers/me/:id/test', async (request, reply) => {
    const userId = requireUserId(request);
    const server = await mcpServerService.getMineForRuntime(userId, pathId(request));
    try {
      const tools = await mcpClientManager.testConnection(server, mcpServerService.decryptEnv(server));
      return sendOk(reply, tools);
    } catch (e) {
      return sendJson(reply, 200, fail(400, (e as Error).message));
    }
  });

  app.get('/v1/mcp-servers', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    return sendOk(reply, await mcpServerService.list(queryOptStr(request, 'keyword'), queryOptStr(request, 'status')));
  });

  app.get('/v1/mcp-servers/enabled', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    return sendOk(reply, await mcpServerService.listEnabled());
  });

  app.get('/v1/mcp-servers/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    return sendOk(reply, await mcpServerService.get(pathId(request)));
  });

  app.post('/v1/mcp-servers', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    const body = bodyOf<SaveMcpServerRequest>(request);
    const server = await mcpServerService.create(
      body.name ?? '', body.description ?? null, body.serverType ?? '',
      body.command, body.args, body.url, body.env,
    );
    return sendOk(reply, server);
  });

  app.put('/v1/mcp-servers/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    const body = bodyOf<SaveMcpServerRequest>(request);
    const server = await mcpServerService.update(
      pathId(request), body.name, body.description, body.serverType,
      body.command, body.args, body.url, body.env,
    );
    return sendOk(reply, server);
  });

  app.put('/v1/mcp-servers/:id/status', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    const body = bodyOf<UpdateStatusRequest>(request);
    await mcpServerService.updateStatus(pathId(request), body.status ?? '');
    return sendOk(reply, await mcpServerService.get(pathId(request)));
  });

  app.delete('/v1/mcp-servers/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    await mcpServerService.delete(pathId(request));
    return sendOk(reply);
  });

  app.post('/v1/mcp-servers/:id/test', async (request, reply) => {
    const userId = requireUserId(request);
    await assertAdmin(permissionService, userId);
    const server = await mcpServerService.getForRuntime(pathId(request));
    try {
      const tools = await mcpClientManager.testConnection(server, mcpServerService.decryptEnv(server));
      return sendOk(reply, tools);
    } catch (e) {
      return sendJson(reply, 200, fail(400, (e as Error).message));
    }
  });
}

function toPreferenceVo(server: McpServer, scope: string, userEnabled: boolean): Record<string, unknown> {
  return {
    id: server.id,
    scope,
    name: server.name,
    description: server.description,
    serverType: server.serverType,
    status: server.status,
    userEnabled,
  };
}

async function assertAdmin(
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> },
  userId: number,
): Promise<void> {
  if (!(await permissionService.isAdmin(userId))) {
    throw new BusinessException(403, '仅管理员可管理全局 MCP 服务器');
  }
}
