import type { FastifyInstance } from 'fastify';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { UserTaskPanelPreferenceService } from './task-panel-preference.service.js';
import type { UserWeixinPreferenceService } from './weixin-preference.service.js';
import type { TaskPanelPreferenceState, WeixinPreferenceVO } from './types.js';

export interface PreferenceRouteDeps {
  weixinPreferenceService: UserWeixinPreferenceService;
  taskPanelPreferenceService: UserTaskPanelPreferenceService;
  weixinVoiceReplyDefault: boolean;
}

interface SaveWeixinPreferenceRequest {
  voiceReply?: boolean | null;
}

interface TaskPanelPreferenceRequest {
  groupOrder?: string[] | null;
  collapsedGroups?: string[] | null;
}

export function registerPreferenceRoutes(app: FastifyInstance, deps: PreferenceRouteDeps): void {
  registerUserWeixinPreferenceRoutes(app, deps);
  registerUserTaskPanelPreferenceRoutes(app, deps);
}

export function registerUserWeixinPreferenceRoutes(app: FastifyInstance, deps: PreferenceRouteDeps): void {
  const { weixinPreferenceService, weixinVoiceReplyDefault } = deps;

  app.get('/v1/user-preferences/weixin', async (request, reply) => {
    const userId = requireUserId(request);
    const row = await weixinPreferenceService.get(userId);
    const vo: WeixinPreferenceVO = {
      voiceReply: row != null && row.voiceReply != null ? row.voiceReply === 1 : weixinVoiceReplyDefault,
    };
    return sendOk(reply, vo);
  });

  app.put('/v1/user-preferences/weixin', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<SaveWeixinPreferenceRequest>(request);
    const voiceReply = body.voiceReply === true;
    await weixinPreferenceService.save(userId, voiceReply);
    return sendOk(reply, { voiceReply } satisfies WeixinPreferenceVO);
  });
}

export function registerUserTaskPanelPreferenceRoutes(app: FastifyInstance, deps: PreferenceRouteDeps): void {
  const { taskPanelPreferenceService } = deps;

  app.get('/v1/user-preferences/task-panel', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, toTaskPanelVO(await taskPanelPreferenceService.get(userId)));
  });

  app.put('/v1/user-preferences/task-panel', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<TaskPanelPreferenceRequest>(request);
    const state: TaskPanelPreferenceState = {
      groupOrder: body.groupOrder ?? [],
      collapsedGroups: body.collapsedGroups ?? [],
    };
    return sendOk(reply, toTaskPanelVO(await taskPanelPreferenceService.save(userId, state)));
  });
}

function toTaskPanelVO(state: TaskPanelPreferenceState): TaskPanelPreferenceState {
  return {
    groupOrder: state.groupOrder,
    collapsedGroups: state.collapsedGroups,
  };
}
