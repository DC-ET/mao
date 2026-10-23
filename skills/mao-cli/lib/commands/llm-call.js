'use strict';

const {
  getString,
  getNumber,
  getBool,
  pickDefined,
  hasFlag,
} = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `llm-call — LLM 调用流水

命令:
  mao llm-call me [--page] [--size] [--scene] [--success] [--cancelled] [--session-id] [--model-id] [--start-date] [--end-date]
  mao llm-call list [--page] [--size] [--user-id] [--session-id] [--agent-id] [--model-id] [--scene] [--success] [--cancelled] [--start-date] [--end-date]

结果三态: --success true=成功; --success false=纯失败(不含取消); --cancelled true=用户取消(点停止), 与成败互斥另列一档
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  const success = getBool(flags, 'success');
  const cancelled = getBool(flags, 'cancelled');
  const common = pickDefined({
    page: getNumber(flags, 'page'),
    size: getNumber(flags, 'size'),
    sessionId: getNumber(flags, 'session-id'),
    modelId: getNumber(flags, 'model-id'),
    scene: getString(flags, 'scene'),
    success: success === undefined ? undefined : success,
    cancelled: cancelled === undefined ? undefined : cancelled,
    startDate: getString(flags, 'start-date'),
    endDate: getString(flags, 'end-date'),
  });

  switch (subcommand) {
    case 'me': {
      const result = await get(ctx, '/llm-calls/me', common);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'list': {
      const result = await get(ctx, '/admin/llm-calls', pickDefined({
        ...common,
        userId: getNumber(flags, 'user-id'),
        agentId: getNumber(flags, 'agent-id'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 llm-call 命令: ${subcommand}`);
  }
}

module.exports = { help, run };
