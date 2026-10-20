'use strict';

const fs = require('node:fs');
const {
  requireFlag,
  requireNumber,
  getString,
  optionalNumber,
  optionalBoolean,
  hasFlag,
} = require('../args');
const { get, post, put, del } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `user-tool — 自定义 HTTP 工具（用户 CRUD + 管理端只读）

用户端（本人数据）:
  mao user-tool me-list
  mao user-tool me-create --body '<草稿JSON>' [--body-file <路径>]
  mao user-tool me-update --id ID --body '<草稿JSON>' [--body-file <路径>]
  mao user-tool me-delete --id ID
  mao user-tool me-enabled --id ID --enabled true|false
  mao user-tool me-test --body '<草稿JSON+arguments>' [--body-file <路径>]

管理端（只读，需 user_tool:read 权限）:
  mao user-tool admin-list [--page N] [--size N] [--keyword] [--username] [--enabled true|false]
  mao user-tool admin-stats [--slug <工具名>]

草稿 JSON 字段: name / displayName / description / method / url / headers([{key,value}] 或对象) /
bodyTemplate / readOnly / timeoutMs / enabled / params([{name,label,type,required,defaultValue}])。
me-test 额外接受 arguments（对象）。请求头敏感值编辑时回传 ****** 表示不修改；试运行不接受掩码值。
`;
}

function readBody(flags) {
  const inline = getString(flags, 'body');
  const file = getString(flags, 'body-file');
  if (inline && file) {
    printError('--body 与 --body-file 只能二选一');
    process.exit(1);
  }
  const raw = inline ?? (file ? fs.readFileSync(file, 'utf8') : undefined);
  if (!raw) {
    printError('缺少必填参数 --body 或 --body-file（完整草稿 JSON）');
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('草稿须为 JSON 对象');
    }
    return parsed;
  } catch (e) {
    printError(`草稿 JSON 无效: ${(e && e.message) || e}`);
    process.exit(1);
  }
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'me-list': {
      emitResult(await get(ctx, '/user-tools'), { raw: ctx.raw });
      return;
    }
    case 'me-create': {
      emitResult(await post(ctx, '/user-tools', readBody(flags)), { raw: ctx.raw });
      return;
    }
    case 'me-update': {
      const id = requireNumber(flags, 'id', '工具 ID');
      emitResult(await put(ctx, `/user-tools/${id}`, readBody(flags)), { raw: ctx.raw });
      return;
    }
    case 'me-delete': {
      const id = requireNumber(flags, 'id', '工具 ID');
      emitResult(await del(ctx, `/user-tools/${id}`), { raw: ctx.raw });
      return;
    }
    case 'me-enabled': {
      const id = requireNumber(flags, 'id', '工具 ID');
      const enabledRaw = requireFlag(flags, 'enabled', 'enabled');
      const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === true;
      emitResult(await put(ctx, `/user-tools/${id}/enabled`, { enabled }), { raw: ctx.raw });
      return;
    }
    case 'me-test': {
      emitResult(await post(ctx, '/user-tools/test', readBody(flags)), { raw: ctx.raw });
      return;
    }
    case 'admin-list': {
      const result = await get(ctx, '/admin/user-tools', {
        page: optionalNumber(flags, 'page'),
        size: optionalNumber(flags, 'size'),
        keyword: getString(flags, 'keyword'),
        username: getString(flags, 'username'),
        enabled: optionalBoolean(flags, 'enabled'),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'admin-stats': {
      const result = await get(ctx, '/admin/user-tools/stats', {
        slug: getString(flags, 'slug'),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 user-tool 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
