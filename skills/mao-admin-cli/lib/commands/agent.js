'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumber,
  getBool,
  getStringList,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put, del } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `agent — Agent 管理

命令:
  mao-admin agent list [--keyword]
  mao-admin agent get --id
  mao-admin agent create --name --system-prompt [--description] [--tags a,b] [--skill-names x,y] [--experiences-json '[{...}]']
  mao-admin agent update --id [--name] [--system-prompt] [--description] [--tags] [--skill-names] [--experiences-json]
  mao-admin agent delete --id
  mao-admin agent experience list --agent-id
  mao-admin agent experience create --agent-id [--content] [--sort-order] [--enabled]
  mao-admin agent experience update --agent-id --id [--content] [--sort-order] [--enabled]
  mao-admin agent experience delete --agent-id --id
`;
}

function parseExperiencesJson(flags) {
  const raw = getString(flags, 'experiences-json');
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const err = new Error('--experiences-json 必须是 JSON 数组');
      err.exitCode = 1;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e.exitCode) throw e;
    const err = new Error(`--experiences-json 解析失败: ${e.message}`);
    err.exitCode = 1;
    throw err;
  }
}

async function runExperience(ctx, action, flags) {
  const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
  switch (action) {
    case 'list': {
      const result = await get(ctx, `/agents/${agentId}/experiences`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = pickDefined({
        content: getString(flags, 'content'),
        sortOrder: getNumber(flags, 'sort-order'),
        enabled: getBool(flags, 'enabled'),
      });
      const result = await post(ctx, `/agents/${agentId}/experiences`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '经验 ID');
      const body = pickDefined({
        content: getString(flags, 'content'),
        sortOrder: getNumber(flags, 'sort-order'),
        enabled: getBool(flags, 'enabled'),
      });
      const result = await put(ctx, `/agents/${agentId}/experiences/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '经验 ID');
      const result = await del(ctx, `/agents/${agentId}/experiences/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 agent experience 命令: ${action}`);
      process.exit(1);
  }
}

async function run(ctx, subcommand, rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  if (subcommand === 'experience') {
    const action = rest[0];
    if (!action || hasFlag(flags, 'help')) {
      process.stdout.write(help() + '\n');
      return;
    }
    await runExperience(ctx, action, flags);
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/agents', pickDefined({
        keyword: getString(flags, 'keyword'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await get(ctx, `/agents/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = pickDefined({
        name: requireFlag(flags, 'name', '名称'),
        systemPrompt: requireFlag(flags, 'system-prompt', '系统提示词'),
        description: getString(flags, 'description'),
        tags: getStringList(flags, 'tags'),
        skillNames: getStringList(flags, 'skill-names'),
        experiences: parseExperiencesJson(flags),
      });
      const result = await post(ctx, '/agents', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const body = pickDefined({
        name: getString(flags, 'name'),
        systemPrompt: getString(flags, 'system-prompt'),
        description: getString(flags, 'description'),
        tags: getStringList(flags, 'tags'),
        skillNames: getStringList(flags, 'skill-names'),
        experiences: parseExperiencesJson(flags),
      });
      const result = await put(ctx, `/agents/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await del(ctx, `/agents/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 agent 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
