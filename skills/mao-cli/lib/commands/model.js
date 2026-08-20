'use strict';

const {
  createCliError,
  requireNumber,
  requireString,
  getString,
  getNumber,
  getBool01,
  pickDefined,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao model list-active
  mao model default
  mao model list [--page] [--size] [--keyword] [--provider] [--status] [--supports-vision] [--is-default]
  mao model get --id <id>
  mao model providers
  mao model create --name --provider --base-url --api-key --model-id [--context-window-tokens] [--supports-vision 0|1] [--is-default 0|1]
  mao model update --id [--name] [--provider] [--base-url] [--api-key] [--model-id] [--context-window-tokens] [--supports-vision] [--is-default]
  mao model delete --id
  mao model set-status --id --status
  mao model test --id
`;

function modelBody(flags, { requireAll = false } = {}) {
  if (requireAll) {
    return pickDefined({
      name: requireString(flags, 'name', '显示名称'),
      provider: requireString(flags, 'provider', '提供商'),
      baseUrl: requireString(flags, 'base-url', '模型 API Base URL'),
      apiKey: requireString(flags, 'api-key', 'API Key'),
      modelId: requireString(flags, 'model-id', '模型 ID'),
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

async function handle(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  switch (subcommand) {
    case 'list-active': {
      const result = await request({ ...common, method: 'GET', path: '/models/active' });
      outputResult(result, globals);
      return;
    }
    case 'default': {
      const result = await request({ ...common, method: 'GET', path: '/models/default' });
      outputResult(result, globals);
      return;
    }
    case 'list': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/models',
        query: pickDefined({
          page: getNumber(flags, 'page'),
          size: getNumber(flags, 'size'),
          keyword: getString(flags, 'keyword'),
          provider: getString(flags, 'provider'),
          status: getNumber(flags, 'status'),
          supportsVision: getNumber(flags, 'supports-vision'),
          isDefault: getNumber(flags, 'is-default'),
        }),
      });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await request({ ...common, method: 'GET', path: `/models/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'providers': {
      const result = await request({ ...common, method: 'GET', path: '/models/providers' });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const body = modelBody(flags, { requireAll: true });
      const result = await request({ ...common, method: 'POST', path: '/models', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const body = modelBody(flags, { requireAll: false });
      const result = await request({ ...common, method: 'PUT', path: `/models/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/models/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'set-status': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const status = requireNumber(flags, 'status', '状态');
      const result = await request({
        ...common,
        method: 'PATCH',
        path: `/models/${id}/status`,
        body: { status },
      });
      outputResult(result, globals);
      return;
    }
    case 'test': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await request({ ...common, method: 'POST', path: `/models/${id}/test`, body: {} });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 model 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
