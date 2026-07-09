'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumber,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, patch } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `notification — 通知

命令:
  mao-admin notification list [--page] [--size] [--type] [--is-read] [--user-id]
  mao-admin notification create --user-id --type --title --content
  mao-admin notification mark-read --id
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/notifications', pickDefined({
        page: getNumber(flags, 'page'),
        size: getNumber(flags, 'size'),
        type: getString(flags, 'type'),
        isRead: getNumber(flags, 'is-read'),
        userId: getNumber(flags, 'user-id'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = {
        userId: requireNumber(flags, 'user-id', '用户 ID'),
        type: requireFlag(flags, 'type', '通知类型'),
        title: requireFlag(flags, 'title', '标题'),
        content: requireFlag(flags, 'content', '内容'),
      };
      const result = await post(ctx, '/notifications', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'mark-read': {
      const id = requireNumber(flags, 'id', '通知 ID');
      const result = await patch(ctx, `/notifications/${id}/read`, {});
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 notification 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
