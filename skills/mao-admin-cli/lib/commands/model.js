'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumber,
  getBool01,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put, patch, del } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `model — LLM 模型

命令:
  mao-admin model list [--page] [--size] [--keyword] [--provider] [--status] [--supports-vision] [--is-default]
  mao-admin model get --id
  mao-admin model providers
  mao-admin model create --name --provider --base-url --api-key --model-id [--context-window-tokens] [--supports-vision 0|1] [--is-default 0|1]
  mao-admin model update --id (同 create 字段)
  mao-admin model delete --id
  mao-admin model set-status --id --status
  mao-admin model test --id
`;
}

function modelBody(flags, { requireAll = false } = {}) {
  if (requireAll) {
    return pickDefined({
      name: requireFlag(flags, 'name', '显示名称'),
      provider: requireFlag(flags, 'provider', '提供商'),
      baseUrl: requireFlag(flags, 'base-url', '模型 API Base URL'),
      apiKey: requireFlag(flags, 'api-key', 'API Key'),
      modelId: requireFlag(flags, 'model-id', '模型 ID'),
      contextWindowTokens: getNumber(flags, 'context-window-tokens'),
      supportsVision: getBool01(flags, 'supports-vision'),
      isDefault: getBool01(flags, 'is-default'),
    });
  }
  return pickDefined({
    name: getString(flags, 'name'),
    provider: getString(flags, 'provider'),
    baseUrl: getString(flags, 'base-url'),
    apiKey: getString(flags, 'api-key'),
    modelId: getString(flags, 'model-id'),
    contextWindowTokens: getNumber(flags, 'context-window-tokens'),
    supportsVision: getBool01(flags, 'supports-vision'),
    isDefault: getBool01(flags, 'is-default'),
  });
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/models', pickDefined({
        page: getNumber(flags, 'page'),
        size: getNumber(flags, 'size'),
        keyword: getString(flags, 'keyword'),
        provider: getString(flags, 'provider'),
        status: getNumber(flags, 'status'),
        supportsVision: getNumber(flags, 'supports-vision'),
        isDefault: getNumber(flags, 'is-default'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await get(ctx, `/models/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'providers': {
      const result = await get(ctx, '/models/providers');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      // --base-url 在此命令中表示模型服务商 API 地址（非管理后台地址）
      const body = modelBody(flags, { requireAll: true });
      const result = await post(ctx, '/models', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const body = modelBody(flags, { requireAll: false });
      const result = await put(ctx, `/models/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await del(ctx, `/models/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'set-status': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const status = requireNumber(flags, 'status', '状态');
      const result = await patch(ctx, `/models/${id}/status`, { status });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'test': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await post(ctx, `/models/${id}/test`, {});
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 model 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
