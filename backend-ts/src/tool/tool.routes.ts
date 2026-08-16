import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { pathParam } from '../common/request.js';
import type { ToolService } from './tool.service.js';
import type { ToolInfo, ToolVO } from './types.js';

export interface ToolRouteDeps {
  toolService: ToolService;
}

export function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): void {
  const { toolService } = deps;

  app.get('/v1/tools', async (_request, reply) => {
    return sendOk(reply, toolService.listTools().map(toVO));
  });

  app.get('/v1/tools/:name', async (request, reply) => {
    return sendOk(reply, toVO(toolService.getTool(pathParam(request, 'name'))));
  });
}

function toVO(tool: ToolInfo): ToolVO {
  return { name: tool.name, description: tool.description };
}
