'use strict';

const path = require('node:path');
const { parseArgs, extractGlobalOptions, createCliError, hasHelp } = require('./args');
const { DEFAULT_BASE_URL } = require('./http');

const auth = require('./commands/auth');
const agent = require('./commands/agent');
const model = require('./commands/model');
const session = require('./commands/session');
const adminSession = require('./commands/admin-session');
const skill = require('./commands/skill');
const skillDocs = require('./commands/skill-docs');
const command = require('./commands/command');
const file = require('./commands/file');
const oss = require('./commands/oss');
const pref = require('./commands/pref');
const git = require('./commands/git');
const tool = require('./commands/tool');
const todo = require('./commands/todo');
const scheduledTask = require('./commands/scheduled-task');
const weixin = require('./commands/weixin');
const user = require('./commands/user');
const role = require('./commands/role');
const runtime = require('./commands/runtime');
const analytics = require('./commands/analytics');
const audit = require('./commands/audit');
const settings = require('./commands/settings');
const mcp = require('./commands/mcp');

const GLOBAL_HELP = `mao-cli — Mao 用户端与管理后台统一 CLI

用法:
  mao <模块> <子命令> [选项]

全局选项:
  --base-url <url>     API 根地址，默认 ${DEFAULT_BASE_URL}
  --token <jwt>        覆盖本地缓存的 accessToken
  --json               机器可读 JSON 输出
  --raw                输出完整 Result（含 code/message/data）
  --timeout-ms <n>     请求超时毫秒，默认 30000
  -h, --help           显示帮助

用户端模块:
  auth            登录 / 刷新 / 登出 / 当前用户 / 飞书登录
  agent           Agent CRUD 与经验管理
  model           模型查询与管理端配置
  session         当前用户会话元数据（不含对话）
  todo            会话待办
  skill           个人技能与同步包
  quick-command   快捷指令聚合列表
  command         个人指令 CRUD
  file            附件与工作区文件
  oss             OSS STS
  upload-config   上传配置
  pref            偏好（任务面板/任务通知/微信语音回复）
  scheduled-task  定时任务列表、详情、更新、删除
  weixin          微信 Bot 绑定与二维码状态
  git             Git 凭证
  tool            内置工具查询
  mcp             MCP 偏好与用户级 / 全局服务器

管理端模块:
  user            用户管理
  role            角色与权限
  permission      权限点列表
  skill-docs      全局 Skill 文档
  admin-session   管理端会话检索
  runtime         运行监控
  analytics       分析汇总
  audit           审计日志
  settings        系统设置

环境变量:
  MAO_BASE_URL
  MAO_USER_BASE_URL / MAO_ADMIN_BASE_URL   兼容旧名
  MAO_TOKEN
  MAO_REFRESH_TOKEN

Token 缓存: ~/.mao/auth.json

明确不支持:
  消息发送、消息队列写操作、WebSocket Agent 运行（请用 mao-agent）

兼容别名:
  mao-user / mao-user-cli / mao-admin / mao-admin-cli 指向同一二进制。
  以 mao-admin 调用时，session → admin-session、skill → skill-docs。

注意:
  model create/update 的 --base-url 表示「模型服务商 API 地址」。
  此时请用环境变量 MAO_BASE_URL 指定服务端地址，避免与全局 --base-url 冲突。

示例:
  mao auth login --username demo --password '***'
  mao session create --agent-id 1 --execution-mode LOCAL --workspace /tmp/ws
  mao user list --page 1 --size 20
`;

const MODULES = {
  auth,
  agent,
  model,
  session,
  'admin-session': adminSession,
  todo,
  skill,
  'skill-docs': skillDocs,
  'quick-command': {
    handle(ctx) {
      return command.handleQuickCommand(ctx);
    },
  },
  command,
  file,
  oss: {
    handle(ctx) {
      return oss.handleOss(ctx);
    },
  },
  'upload-config': {
    handle(ctx) {
      return oss.handleUploadConfig(ctx);
    },
  },
  pref,
  'scheduled-task': scheduledTask,
  weixin,
  git,
  tool,
  user,
  role,
  permission: {
    help() {
      return role.helpPermission();
    },
    run(runCtx, subcommand, rest, flags) {
      return role.runPermission(runCtx, subcommand, rest, flags);
    },
  },
  runtime,
  analytics,
  audit,
  settings,
  mcp,
};

const ADMIN_COMPAT = {
  session: 'admin-session',
  skill: 'skill-docs',
};

function invokedName() {
  return path.basename(process.argv[1] || '').replace(/\.js$/, '');
}

function invokedAsAdmin() {
  const name = invokedName();
  return name === 'mao-admin' || name === 'mao-admin-cli';
}

async function dispatch(mod, ctx) {
  if (typeof mod.handle === 'function') {
    return mod.handle(ctx);
  }
  if (typeof mod.run === 'function') {
    const runCtx = {
      baseUrl: ctx.globals.baseUrl,
      token: ctx.globals.token,
      timeoutMs: ctx.globals.timeoutMs,
      raw: ctx.globals.raw,
    };
    return mod.run(runCtx, ctx.subcommand, ctx.rest, ctx.flags);
  }
  if (hasHelp(ctx.flags) && typeof mod.help === 'function') {
    process.stdout.write(mod.help() + '\n');
    return;
  }
  throw createCliError(`模块未实现: ${ctx.moduleName}`);
}

async function run(argv) {
  const { positionals, flags } = parseArgs(argv);

  if (positionals.length === 0 || (hasHelp(flags) && positionals.length === 0)) {
    process.stdout.write(GLOBAL_HELP);
    return;
  }

  let [moduleName, subcommand, ...rest] = positionals;
  if (moduleName === 'help') {
    process.stdout.write(GLOBAL_HELP);
    return;
  }

  if (invokedAsAdmin() && ADMIN_COMPAT[moduleName]) {
    moduleName = ADMIN_COMPAT[moduleName];
  }

  const mod = MODULES[moduleName];
  if (!mod) {
    throw createCliError(`未知模块: ${moduleName}\n\n${GLOBAL_HELP}`);
  }

  const reserveBaseUrl =
    moduleName === 'model' && (subcommand === 'create' || subcommand === 'update');
  const globals = extractGlobalOptions(flags, { reserveBaseUrl });
  const ctx = { moduleName, subcommand, rest, flags, globals, positionals };
  await dispatch(mod, ctx);
}

module.exports = { run, GLOBAL_HELP };
