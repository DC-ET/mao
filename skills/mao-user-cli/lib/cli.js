'use strict';

const { parseArgs, extractGlobalOptions, createCliError } = require('./args');
const { DEFAULT_BASE_URL } = require('./http');

const auth = require('./commands/auth');
const agent = require('./commands/agent');
const model = require('./commands/model');
const session = require('./commands/session');
const skill = require('./commands/skill');
const command = require('./commands/command');
const file = require('./commands/file');
const oss = require('./commands/oss');
const pref = require('./commands/pref');
const git = require('./commands/git');
const tool = require('./commands/tool');
const todo = require('./commands/todo');

const GLOBAL_HELP = `mao-user-cli — Mao 用户端（桌面端）非对话操作 CLI

用法:
  mao-user <模块> <子命令> [选项]

全局选项:
  --base-url <url>     API 根地址，默认 ${DEFAULT_BASE_URL}
  --token <jwt>        覆盖本地缓存的 accessToken
  --json               机器可读 JSON 输出
  --raw                输出完整 Result（含 code/message/data）
  --timeout-ms <n>     请求超时毫秒，默认 30000
  -h, --help           显示帮助

模块:
  auth            登录 / 刷新 / 登出 / 当前用户 / 飞书登录
  agent           Agent CRUD 与经验管理
  model           可用模型查询
  session         会话元数据管理（不含对话）
  todo            会话待办
  skill           个人技能与同步包
  quick-command   快捷指令聚合列表
  command         个人指令 CRUD
  file            附件与工作区文件
  oss             OSS STS
  upload-config   上传配置
  pref            任务面板偏好
  git             Git 凭证
  tool            内置工具查询

环境变量:
  MAO_USER_BASE_URL
  MAO_TOKEN
  MAO_REFRESH_TOKEN

Token 缓存: ~/.mao/auth.json（与 mao-admin-cli 共用）

明确不支持:
  消息发送、消息历史、消息队列、WebSocket Agent 运行、edit_and_resend、activities

示例:
  mao-user auth login --username demo --password '***'
  mao-user session create --agent-id 1 --execution-mode LOCAL --workspace /tmp/ws
  mao-user skill sync-package --session-id 12 --out skills.zip
`;

async function run(argv) {
  const { positionals, flags } = parseArgs(argv);
  const globals = extractGlobalOptions(flags);

  if (positionals.length === 0 || (globals.help && positionals.length === 0)) {
    process.stdout.write(GLOBAL_HELP);
    return;
  }

  const [moduleName, subcommand, ...rest] = positionals;
  const ctx = { moduleName, subcommand, rest, flags, globals, positionals };

  switch (moduleName) {
    case 'auth':
      return auth.handle(ctx);
    case 'agent':
      return agent.handle(ctx);
    case 'model':
      return model.handle(ctx);
    case 'session':
      return session.handle(ctx);
    case 'todo':
      return todo.handle(ctx);
    case 'skill':
      return skill.handle(ctx);
    case 'quick-command':
      return command.handleQuickCommand(ctx);
    case 'command':
      return command.handle(ctx);
    case 'file':
      return file.handle(ctx);
    case 'oss':
      return oss.handleOss(ctx);
    case 'upload-config':
      return oss.handleUploadConfig(ctx);
    case 'pref':
      return pref.handle(ctx);
    case 'git':
      return git.handle(ctx);
    case 'tool':
      return tool.handle(ctx);
    case 'help':
      process.stdout.write(GLOBAL_HELP);
      return;
    default:
      throw createCliError(`未知模块: ${moduleName}\n\n${GLOBAL_HELP}`);
  }
}

module.exports = { run, GLOBAL_HELP };
