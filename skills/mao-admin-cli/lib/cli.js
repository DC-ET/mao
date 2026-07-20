'use strict';

const { parseArgs, hasFlag, getString, getNumber } = require('./args');
const { resolveBaseUrl, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } = require('./http');
const { printError } = require('./output');

const authCmd = require('./commands/auth');
const userCmd = require('./commands/user');
const roleCmd = require('./commands/role');
const agentCmd = require('./commands/agent');
const modelCmd = require('./commands/model');
const skillCmd = require('./commands/skill');
const sessionCmd = require('./commands/session');
const runtimeCmd = require('./commands/runtime');
const analyticsCmd = require('./commands/analytics');
const auditCmd = require('./commands/audit');
const settingsCmd = require('./commands/settings');

const GLOBAL_HELP = `mao-admin-cli — Mao 管理后台 API 命令行工具

用法:
  mao-admin <module> <command> [options]

全局选项:
  --base-url <url>     API 根地址（默认 ${DEFAULT_BASE_URL}）
  --token <jwt>        覆盖本地缓存的 accessToken
  --json               机器可读 JSON 输出（默认已输出 JSON data）
  --raw                输出完整 Result {code,message,data,timestamp}
  --timeout-ms <n>     请求超时毫秒（默认 ${DEFAULT_TIMEOUT_MS}）
  -h, --help           显示帮助

模块:
  auth           登录 / 刷新 / 登出 / 当前用户
  user           用户管理
  role           角色与权限
  permission     权限点列表（permission list）
  agent          Agent 与经验
  model          LLM 模型
  skill          全局 Skill 文档
  session        管理端会话
  runtime        运行监控
  analytics      分析汇总
  audit          审计日志
  settings       系统设置

环境变量:
  MAO_ADMIN_BASE_URL
  MAO_TOKEN
  MAO_REFRESH_TOKEN

Token 缓存: ~/.mao/auth.json（与 mao-user-cli 共用）

查看模块帮助:
  mao-admin <module> --help

注意:
  model create/update 的 --base-url 表示「模型服务商 API 地址」。
  此时请用环境变量 MAO_ADMIN_BASE_URL 指定管理后台地址，避免与全局 --base-url 冲突。
`;

const MODULES = {
  auth: authCmd,
  user: userCmd,
  role: roleCmd,
  agent: agentCmd,
  model: modelCmd,
  skill: skillCmd,
  session: sessionCmd,
  runtime: runtimeCmd,
  analytics: analyticsCmd,
  audit: auditCmd,
  settings: settingsCmd,
  permission: {
    help() {
      return roleCmd.helpPermission();
    },
    async run(ctx, subcommand, rest, flags) {
      return roleCmd.runPermission(ctx, subcommand, rest, flags);
    },
  },
};

function buildContext(flags, { reserveBaseUrlForModel = false } = {}) {
  // model create/update 的 --base-url 是模型字段，不作为 CLI host
  const cliBaseUrl = reserveBaseUrlForModel
    ? undefined
    : getString(flags, 'base-url');
  return {
    baseUrl: resolveBaseUrl(cliBaseUrl),
    token: getString(flags, 'token'),
    timeoutMs: getNumber(flags, 'timeout-ms', DEFAULT_TIMEOUT_MS),
    json: true,
    raw: hasFlag(flags, 'raw'),
  };
}

async function run(argv) {
  const { command, subcommand, rest, flags } = parseArgs(argv);

  if (!command || ((hasFlag(flags, 'help') || flags.h) && !MODULES[command])) {
    process.stdout.write(GLOBAL_HELP);
    return;
  }

  const mod = MODULES[command];
  if (!mod) {
    printError(`未知模块: ${command}`);
    process.stdout.write('\n' + GLOBAL_HELP);
    process.exit(1);
  }

  if (hasFlag(flags, 'help') || flags.h) {
    if (typeof mod.help === 'function') {
      process.stdout.write(mod.help() + '\n');
      return;
    }
    process.stdout.write(GLOBAL_HELP);
    return;
  }

  const reserveBaseUrlForModel =
    command === 'model' && (subcommand === 'create' || subcommand === 'update');
  const ctx = buildContext(flags, { reserveBaseUrlForModel });
  await mod.run(ctx, subcommand, rest, flags);
}

module.exports = { run, GLOBAL_HELP };
