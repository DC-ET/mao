'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  parseCsv,
  parseJsonFlag,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user agent list [--keyword <关键词>]
  mao-user agent get --id <id>
  mao-user agent create --name <名称> --system-prompt <提示词> [--description] [--tags] [--skill-names] [--experiences-json]
  mao-user agent update --id <id> [--name] [--description] [--system-prompt] [--tags] [--skill-names] [--experiences-json]
  mao-user agent delete --id <id>
  mao-user agent experience list --agent-id <id>
  mao-user agent experience create --agent-id <id> --content <内容> [--sort-order] [--enabled]
  mao-user agent experience update --agent-id <id> --id <经验id> [--content] [--sort-order] [--enabled]
  mao-user agent experience delete --agent-id <id> --id <经验id>
`;

function buildAgentBody(flags, { requireCore = false } = {}) {
  const body = {};
  const name = optionalString(flags, 'name');
  const description = optionalString(flags, 'description');
  const systemPrompt = optionalString(flags, 'system-prompt');
  const tags = parseCsv(optionalString(flags, 'tags'));
  const skillNames = parseCsv(optionalString(flags, 'skill-names'));
  const experiences = parseJsonFlag(flags, 'experiences-json');

  if (requireCore) {
    body.name = requireString(flags, 'name', 'Agent 名称');
    body.systemPrompt = requireString(flags, 'system-prompt', '角色定义');
  } else {
    if (name !== undefined) body.name = name;
    if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
  }
  if (description !== undefined) body.description = description;
  if (tags !== undefined) body.tags = tags;
  if (skillNames !== undefined) body.skillNames = skillNames;
  if (experiences !== undefined) body.experiences = experiences;
  return body;
}

async function handle(ctx) {
  const { subcommand, rest, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  if (subcommand === 'experience') {
    const action = rest[0];
    if (!action || hasHelp(flags)) {
      process.stdout.write(HELP);
      return;
    }
    const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
    switch (action) {
      case 'list': {
        const result = await request({
          ...common,
          method: 'GET',
          path: `/agents/${agentId}/experiences`,
        });
        outputResult(result, globals);
        return;
      }
      case 'create': {
        const content = requireString(flags, 'content', '经验内容');
        const body = {
          content,
          sortOrder: optionalNumber(flags, 'sort-order'),
          enabled: optionalBoolean(flags, 'enabled'),
        };
        const result = await request({
          ...common,
          method: 'POST',
          path: `/agents/${agentId}/experiences`,
          body,
        });
        outputResult(result, globals);
        return;
      }
      case 'update': {
        const id = requireNumber(flags, 'id', '经验 ID');
        const body = {};
        const content = optionalString(flags, 'content');
        const sortOrder = optionalNumber(flags, 'sort-order');
        const enabled = optionalBoolean(flags, 'enabled');
        if (content !== undefined) body.content = content;
        if (sortOrder !== undefined) body.sortOrder = sortOrder;
        if (enabled !== undefined) body.enabled = enabled;
        if (Object.keys(body).length === 0) {
          throw createCliError('请至少提供一个更新字段');
        }
        const result = await request({
          ...common,
          method: 'PUT',
          path: `/agents/${agentId}/experiences/${id}`,
          body,
        });
        outputResult(result, globals);
        return;
      }
      case 'delete': {
        const id = requireNumber(flags, 'id', '经验 ID');
        const result = await request({
          ...common,
          method: 'DELETE',
          path: `/agents/${agentId}/experiences/${id}`,
        });
        outputResult(result, globals);
        return;
      }
      default:
        throw createCliError(`未知 agent experience 子命令: ${action}\n${HELP}`);
    }
  }

  switch (subcommand) {
    case 'list': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/agents',
        query: { keyword: optionalString(flags, 'keyword') },
      });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await request({ ...common, method: 'GET', path: `/agents/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const body = buildAgentBody(flags, { requireCore: true });
      const result = await request({ ...common, method: 'POST', path: '/agents', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const body = buildAgentBody(flags);
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供一个更新字段');
      }
      const result = await request({ ...common, method: 'PUT', path: `/agents/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await request({ ...common, method: 'DELETE', path: `/agents/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 agent 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
