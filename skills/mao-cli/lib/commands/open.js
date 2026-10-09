'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao open token list
  mao open token create --name <名称> [--scope open:run]        # scope 逗号分隔，首期仅 open:run；明文只显示一次
  mao open token delete --id <id>
  mao open token log-full-body --id <id> --enabled true|false
  mao open token re-enable --id <id>
  mao open calls list [--token-id <id>] [--trigger-id <id>] [--page <n>] [--size <n>]
  mao open calls get --id <id>
  mao open trigger list
  mao open trigger create --name <名称> --agent-id <id> [--session-id <id>]   # secret 只显示一次
  mao open trigger update --id <id> [--name] [--agent-id] [--session-id] [--enabled true|false]
  mao open trigger delete --id <id>
  mao open trigger rotate-secret --id <id>                       # 新明文只显示一次
  mao open subscription list
  mao open subscription create --event <task.completed|task.failed|question.pending> --target-url <https-url>  # secret 只显示一次
  mao open subscription set-enabled --id <id> --enabled true|false
  mao open subscription deliveries --id <订阅id>
  mao open subscription delete --id <id>
  mao open run --agent-id <id> --message <文本> [--session-id <id>] --api-token <mao_...>

说明:
  管理子命令（token/trigger/subscription）走登录会话 JWT，只能管理本人资源；
  API Token 仅在 /v1/open/** 生效，不能调用其它 REST 接口。
  token/trigger/subscription 的 create 与 rotate-secret 返回的明文（token/secret）只出现一次，请当场保存。
  run 需 --api-token 传 mao_ 前缀 API Token；会话忙时自动排队（响应 queued=true，202 异步语义）。
  calls 查看本人 Token/触发器的入站调用流水。完整记录默认关闭，开启后请求体会进流水并留审计。
  连续失败达到阈值的 Token 会自动停用，恢复用 token re-enable。管理端重放与统计不在本 CLI。
`;

const EVENTS = new Set(['task.completed', 'task.failed', 'question.pending']);
const SCOPES = new Set(['open:run']);

function parseCsvList(raw) {
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

async function tokenGroup(ctx) {
  const { action, flags, globals, common } = ctx;
  switch (action) {
    case 'list': {
      outputResult(await request({ ...common, method: 'GET', path: '/open/tokens' }), globals);
      return;
    }
    case 'create': {
      const name = requireString(flags, 'name', '令牌名称');
      const rawScopes = optionalString(flags, 'scope') ?? 'open:run';
      const scopes = parseCsvList(rawScopes);
      for (const scope of scopes) {
        if (!SCOPES.has(scope)) {
          throw createCliError(`--scope 仅支持 ${[...SCOPES].join(' / ')}`);
        }
      }
      if (scopes.length === 0) {
        throw createCliError('--scope 不能为空');
      }
      const result = await request({
        ...common,
        method: 'POST',
        path: '/open/tokens',
        body: { name, scopes },
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '令牌 ID');
      outputResult(await request({ ...common, method: 'DELETE', path: `/open/tokens/${id}` }), globals);
      return;
    }
    case 'log-full-body': {
      const id = requireNumber(flags, 'id', '令牌 ID');
      const enabled = optionalBoolean(flags, 'enabled');
      if (enabled == null) throw createCliError('--enabled 必须为 true 或 false');
      outputResult(await request({ ...common, method: 'PUT', path: `/open/tokens/${id}/log-full-body`, body: { enabled } }), globals);
      return;
    }
    case 're-enable': {
      const id = requireNumber(flags, 'id', '令牌 ID');
      outputResult(await request({ ...common, method: 'POST', path: `/open/tokens/${id}/re-enable` }), globals);
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

async function triggerGroup(ctx) {
  const { action, flags, globals, common } = ctx;
  switch (action) {
    case 'list': {
      outputResult(await request({ ...common, method: 'GET', path: '/open/triggers' }), globals);
      return;
    }
    case 'create': {
      const name = requireString(flags, 'name', '触发器名称');
      const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/open/triggers',
        body: { name, agentId, sessionId: optionalNumber(flags, 'session-id') },
      });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '触发器 ID');
      const body = {};
      const name = optionalString(flags, 'name');
      const agentId = optionalNumber(flags, 'agent-id');
      const sessionId = optionalNumber(flags, 'session-id');
      const enabled = optionalBoolean(flags, 'enabled');
      if (name != null) body.name = name;
      if (agentId != null) body.agentId = agentId;
      if (sessionId != null) body.sessionId = sessionId;
      if (enabled != null) body.enabled = enabled;
      outputResult(await request({ ...common, method: 'PUT', path: `/open/triggers/${id}`, body }), globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '触发器 ID');
      outputResult(await request({ ...common, method: 'DELETE', path: `/open/triggers/${id}` }), globals);
      return;
    }
    case 'rotate-secret': {
      const id = requireNumber(flags, 'id', '触发器 ID');
      const result = await request({
        ...common,
        method: 'POST',
        path: `/open/triggers/${id}/rotate-secret`,
      });
      outputResult(result, globals);
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

async function subscriptionGroup(ctx) {
  const { action, flags, globals, common } = ctx;
  switch (action) {
    case 'list': {
      outputResult(await request({ ...common, method: 'GET', path: '/open/subscriptions' }), globals);
      return;
    }
    case 'create': {
      const event = requireString(flags, 'event', '事件类型');
      if (!EVENTS.has(event)) {
        throw createCliError(`--event 仅支持 ${[...EVENTS].join(' / ')}`);
      }
      const targetUrl = requireString(flags, 'target-url', '目标 URL');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/open/subscriptions',
        body: { event, targetUrl },
      });
      outputResult(result, globals);
      return;
    }
    case 'set-enabled': {
      const id = requireNumber(flags, 'id', '订阅 ID');
      const enabled = optionalBoolean(flags, 'enabled');
      if (enabled == null) {
        throw createCliError('--enabled 必填（true|false）');
      }
      outputResult(await request({
        ...common,
        method: 'PUT',
        path: `/open/subscriptions/${id}`,
        body: { enabled },
      }), globals);
      return;
    }
    case 'deliveries': {
      const id = requireNumber(flags, 'id', '订阅 ID');
      outputResult(await request({ ...common, method: 'GET', path: `/open/subscriptions/${id}/deliveries` }), globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '订阅 ID');
      outputResult(await request({ ...common, method: 'DELETE', path: `/open/subscriptions/${id}` }), globals);
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

async function callsGroup(ctx) {
  const { action, flags, globals, common } = ctx;
  switch (action) {
    case 'list': {
      const query = new URLSearchParams();
      const tokenId = optionalNumber(flags, 'token-id');
      const triggerId = optionalNumber(flags, 'trigger-id');
      const page = optionalNumber(flags, 'page');
      const size = optionalNumber(flags, 'size');
      if (tokenId != null) query.set('tokenId', String(tokenId));
      if (triggerId != null) query.set('triggerId', String(triggerId));
      if (page != null) query.set('page', String(page));
      if (size != null) query.set('size', String(size));
      const qs = query.toString();
      outputResult(await request({ ...common, method: 'GET', path: `/open/calls${qs ? `?${qs}` : ''}` }), globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '流水 ID');
      outputResult(await request({ ...common, method: 'GET', path: `/open/calls/${id}` }), globals);
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

/** run：唯一以 API Token（mao_）调用的子命令，Bearer 头直传，不进 JWT 缓存。 */
async function runAction({ flags, globals }) {
  const apiToken = requireString(flags, 'api-token', 'API Token（mao_ 前缀）');
  if (!apiToken.startsWith('mao_')) {
    throw createCliError('--api-token 必须是 mao_ 前缀的 API Token');
  }
  const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
  const message = requireString(flags, 'message', '触发消息');
  const result = await request({
    baseUrl: globals.baseUrl,
    token: apiToken,
    timeoutMs: globals.timeoutMs,
    method: 'POST',
    path: `/open/agents/${agentId}/run`,
    body: { message, sessionId: optionalNumber(flags, 'session-id') },
  });
  outputResult(result, globals);
}

async function handle(ctx) {
  const { subcommand, flags, globals, rest } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  if (subcommand === 'run') {
    await runAction({ flags, globals });
    return;
  }

  const action = rest[0];
  if (!action) {
    process.stdout.write(HELP);
    return;
  }
  const groupCtx = { action, flags, globals, common };
  switch (subcommand) {
    case 'token':
      await tokenGroup(groupCtx);
      return;
    case 'trigger':
      await triggerGroup(groupCtx);
      return;
    case 'subscription':
      await subscriptionGroup(groupCtx);
      return;
    case 'calls':
      await callsGroup(groupCtx);
      return;
    default:
      process.stdout.write(HELP);
  }
}

module.exports = { handle };
