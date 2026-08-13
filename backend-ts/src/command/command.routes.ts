import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { fail } from '../common/result.js';
import { requireUserId, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptInt } from '../common/request.js';
import type { AgentService } from '../agent/agent.service.js';
import { SYSTEM_USER_ID, type UserCommandService } from './command.service.js';
import type {
  QuickCommandItem,
  QuickCommandsVO,
  SkillCatalog,
  UserCommand,
  UserCommandVO,
  UserSkillCatalog,
} from './types.js';

export interface UserCommandRouteDeps {
  userCommandService: UserCommandService;
}

export interface QuickCommandRouteDeps {
  userCommandService: UserCommandService;
  agentService: AgentService;
  skillLoader: SkillCatalog;
  skillSyncService: UserSkillCatalog;
}

interface CreateCommandRequest {
  name?: string;
  content?: string;
}

interface UpdateCommandRequest {
  name?: string | null;
  content?: string;
}

export function registerUserCommandRoutes(app: FastifyInstance, deps: UserCommandRouteDeps): void {
  const { userCommandService } = deps;

  app.get('/v1/user-commands', async (request, reply) => {
    const userId = requireUserId(request);
    const commands = (await userCommandService.listByUserId(userId)).map(toVO);
    return sendOk(reply, commands);
  });

  app.get('/v1/user-commands/system', async (_request, reply) => {
    const commands = (await userCommandService.listByUserId(SYSTEM_USER_ID)).map(toVO);
    return sendOk(reply, commands);
  });

  app.get('/v1/user-commands/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const command = await userCommandService.getByIdAndUserId(pathId(request), userId);
    if (command == null) {
      return sendJson(reply, 200, fail(404, '指令不存在'));
    }
    return sendOk(reply, toVO(command));
  });

  app.post('/v1/user-commands', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateCommandRequest>(request);
    if (!hasText(body.name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令名称不能为空');
    }
    if (!hasText(body.content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令内容不能为空');
    }
    const command = await userCommandService.create(userId, body.name!, body.content!);
    return sendOk(reply, toVO(command));
  });

  app.put('/v1/user-commands/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<UpdateCommandRequest>(request);
    if (!hasText(body.content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指令内容不能为空');
    }
    const command = await userCommandService.update(userId, pathId(request), body.name, body.content!);
    return sendOk(reply, toVO(command));
  });

  app.delete('/v1/user-commands/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await userCommandService.delete(userId, pathId(request));
    return sendOk(reply);
  });
}

export function registerQuickCommandRoutes(app: FastifyInstance, deps: QuickCommandRouteDeps): void {
  const { userCommandService, agentService, skillLoader, skillSyncService } = deps;

  app.get('/v1/quick-commands', async (request, reply) => {
    const userId = requireUserId(request);
    const agentId = queryOptInt(request, 'agentId');
    let agentSkillNames: string[] | null = null;
    if (agentId != null) {
      agentSkillNames = await resolveAgentSkillNames(agentService, agentId);
    }

    const skills: QuickCommandItem[] = [];
    const seenNames = new Set<string>();

    for (const doc of await Promise.resolve(skillLoader.getAllDocuments())) {
      if (agentSkillNames != null && !agentSkillNames.includes(doc.name)) {
        continue;
      }
      if (!seenNames.has(doc.name)) {
        skills.push({ type: 'skill', name: doc.name, description: doc.description ?? '' });
        seenNames.add(doc.name);
      }
    }

    const userDocs = await skillSyncService.getUserSkillDocuments(userId);
    for (const doc of userDocs) {
      if (seenNames.has(doc.name)) {
        const idx = skills.findIndex((s) => s.name === doc.name);
        if (idx >= 0) {
          skills.splice(idx, 1);
        }
      }
      skills.push({ type: 'skill', name: doc.name, description: doc.description ?? '' });
      seenNames.add(doc.name);
    }

    const commands = await userCommandService.listAvailableForUser(userId);
    const commandItems: QuickCommandItem[] = commands.map((c) => {
      const content = c.content;
      const desc = content != null && content.length > 100 ? content.slice(0, 100) : (content ?? '');
      return { type: 'command', name: c.name, description: desc };
    });

    const vo: QuickCommandsVO = { skills, commands: commandItems };
    return sendOk(reply, vo);
  });
}

export function registerCommandRoutes(
  app: FastifyInstance,
  deps: UserCommandRouteDeps & Partial<QuickCommandRouteDeps>,
): void {
  registerUserCommandRoutes(app, deps);
  if (deps.agentService && deps.skillLoader && deps.skillSyncService) {
    registerQuickCommandRoutes(app, deps as QuickCommandRouteDeps);
  }
}

async function resolveAgentSkillNames(agentService: AgentService, agentId: number): Promise<string[] | null> {
  try {
    const agent = await agentService.getAgent(agentId);
    if (hasText(agent.skillNames)) {
      return JSON.parse(agent.skillNames!) as string[];
    }
  } catch {
    // Failed to resolve skill names for agent — load all skills.
  }
  return null;
}

function toVO(command: UserCommand): UserCommandVO {
  return {
    id: command.id,
    name: command.name,
    content: command.content,
  };
}
