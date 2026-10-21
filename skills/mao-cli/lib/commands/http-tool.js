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
  return `http-tool — 自定义 HTTP 工具（管理员配置 + 按 Agent 关联）

管理端（读需 http_tool:read，写需 http_tool:write 权限）:
  mao http-tool list [--page N] [--size N] [--keyword] [--enabled true|false]
  mao http-tool enabled
  mao http-tool stats [--slug <工具名>]
  mao http-tool create --body '<草稿JSON>' [--body-file <路径>]
  mao http-tool update --id ID --body '<草稿JSON>' [--body-file <路径>]
  mao http-tool delete --id ID
  mao http-tool set-enabled --id ID --enabled true|false
  mao http-tool test --body '<草稿JSON+arguments>' [--body-file <路径>]

草稿 JSON 字段: name / displayName / description / method / url / headers([{key,value}] 或对象) /
bodyTemplate / readOnly / timeoutMs / enabled / params([{name,label,type,required,defaultValue}])。
test 额外接受 arguments（对象）。请求头敏感值编辑时回传 ****** 表示不修改；试运行不接受掩码值。
工具关联到 Agent：mao agent create/update 的 httpToolIds 数组（空数组 = 清空关联）。
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
    case 'list': {
      const result = await get(ctx, '/admin/http-tools', {
        page: optionalNumber(flags, 'page'),
        size: optionalNumber(flags, 'size'),
        keyword: getString(flags, 'keyword'),
        enabled: optionalBoolean(flags, 'enabled'),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'enabled': {
      emitResult(await get(ctx, '/admin/http-tools/enabled'), { raw: ctx.raw });
      return;
    }
    case 'stats': {
      const result = await get(ctx, '/admin/http-tools/stats', {
        slug: getString(flags, 'slug'),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      emitResult(await post(ctx, '/admin/http-tools', readBody(flags)), { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '工具 ID');
      emitResult(await put(ctx, `/admin/http-tools/${id}`, readBody(flags)), { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '工具 ID');
      emitResult(await del(ctx, `/admin/http-tools/${id}`), { raw: ctx.raw });
      return;
    }
    case 'set-enabled': {
      const id = requireNumber(flags, 'id', '工具 ID');
      const enabledRaw = requireFlag(flags, 'enabled', 'enabled');
      const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === true;
      emitResult(await put(ctx, `/admin/http-tools/${id}/enabled`, { enabled }), { raw: ctx.raw });
      return;
    }
    case 'test': {
      emitResult(await post(ctx, '/admin/http-tools/test', readBody(flags)), { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 http-tool 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
