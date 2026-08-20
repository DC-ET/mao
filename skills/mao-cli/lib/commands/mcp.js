'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getStringList,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put, del } = require('../http');
const { emitResult, printError } = require('../output');

function parseEnv(flags) {
  const raw = getString(flags, 'env');
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('env 须为 JSON 对象');
    }
    return obj;
  } catch (e) {
    throw new Error(`--env 无效 JSON: ${(e && e.message) || e}`);
  }
}

function serverBody(flags, { requireName = false, requireType = false } = {}) {
  const body = pickDefined({
    name: requireName ? requireFlag(flags, 'name', '名称') : getString(flags, 'name'),
    description: getString(flags, 'description'),
    serverType: requireType ? requireFlag(flags, 'server-type', 'serverType') : getString(flags, 'server-type'),
    command: getString(flags, 'command'),
    url: getString(flags, 'url'),
    args: getStringList(flags, 'args'),
    env: parseEnv(flags),
  });
  return body;
}

function help() {
  return `mcp — MCP 服务器（全局与用户级）

用户偏好:
  mao mcp preferences
  mao mcp preferences-set --server-id ID --enabled true|false

用户私有 MCP (/mcp-servers/me):
  mao mcp me-list
  mao mcp me-create --name --server-type stdio|http [--description] [--command] [--args a,b] [--url] [--env '{"K":"V"}']
  mao mcp me-update --id ID [--name] [--description] [--server-type] [--command] [--args] [--url] [--env]
  mao mcp me-delete --id ID
  mao mcp me-test --id ID

全局 MCP（管理员）:
  mao mcp list [--keyword] [--status]
  mao mcp enabled
  mao mcp get --id ID
  mao mcp create --name --server-type stdio|http [--description] [--command] [--args] [--url] [--env]
  mao mcp update --id ID [--name] [--description] [--server-type] [--command] [--args] [--url] [--env]
  mao mcp set-status --id ID --status ENABLED|DISABLED
  mao mcp delete --id ID
  mao mcp test --id ID
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'preferences': {
      const result = await get(ctx, '/mcp-servers/preferences');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'preferences-set': {
      const serverId = requireNumber(flags, 'server-id', 'serverId');
      const enabledRaw = requireFlag(flags, 'enabled', 'enabled');
      const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === true;
      const result = await put(ctx, '/mcp-servers/preferences', {
        items: [{ serverId, enabled }],
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me-list': {
      const result = await get(ctx, '/mcp-servers/me');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me-create': {
      const body = serverBody(flags, { requireName: true, requireType: true });
      const result = await post(ctx, '/mcp-servers/me', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me-update': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const body = serverBody(flags);
      const result = await put(ctx, `/mcp-servers/me/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me-delete': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const result = await del(ctx, `/mcp-servers/me/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me-test': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const result = await post(ctx, `/mcp-servers/me/${id}/test`, {});
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'list': {
      const result = await get(ctx, '/mcp-servers', pickDefined({
        keyword: getString(flags, 'keyword'),
        status: getString(flags, 'status'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'enabled': {
      const result = await get(ctx, '/mcp-servers/enabled');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const result = await get(ctx, `/mcp-servers/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = serverBody(flags, { requireName: true, requireType: true });
      const result = await post(ctx, '/mcp-servers', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const body = serverBody(flags);
      const result = await put(ctx, `/mcp-servers/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'set-status': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const status = requireFlag(flags, 'status', 'status');
      const result = await put(ctx, `/mcp-servers/${id}/status`, { status });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const result = await del(ctx, `/mcp-servers/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'test': {
      const id = requireNumber(flags, 'id', 'MCP ID');
      const result = await post(ctx, `/mcp-servers/${id}/test`, {});
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 mcp 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
