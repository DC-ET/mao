import { CliError, EXIT } from './util/exit-codes';

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type IfRunning = 'wait' | 'cancel' | 'fail';
export type OnQuestion = 'ask' | 'fail';
export type OnApproval = 'ask' | 'fail';
export type PermissionLevel = 'READ_ONLY' | 'READ_WRITE' | 'SMART' | 'FULL';
export type CommandName = 'login' | 'logout' | 'status' | 'ls' | 'resume' | 'chat' | 'help' | 'version';

export const LOCAL_APPROVAL_FLAGS = [
  'yolo',
  'force',
  'f',
  'approve-rule',
  'on-approval',
  'strict-danger-check',
  'i-know-what-im-doing',
] as const;

/** @deprecated 使用 LOCAL_APPROVAL_FLAGS；保留别名以免旧单测立刻断裂 */
export const PHASE3_FLAGS = LOCAL_APPROVAL_FLAGS;

const BOOLEAN_SHORT_FLAGS = new Set(['f', 'h', 'V']);

export const DEFAULT_BASE_URL = 'https://mao.etarch.cn/api';
export const DEFAULT_TIMEOUT_MS = 30000;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface CliConfig {
  command: CommandName;
  prompt: string;
  print: boolean;
  outputFormat: OutputFormat;
  resumeSessionId?: number | 'latest';
  continueLast: boolean;
  agent?: string;
  model?: string;
  workspace?: string;
  cloudProject?: string;
  gitClone?: string;
  gitBranch?: string;
  permissionLevel: PermissionLevel;
  thinking: boolean;
  ifRunning: IfRunning;
  onQuestion: OnQuestion;
  onQuestionExplicit: boolean;
  maxDurationSec?: number;
  timeoutMs: number;
  baseUrl?: string;
  token?: string;
  colorFlag?: boolean;
  debug: boolean;
  traceFile?: string;
  includeToolIo: boolean;
  replayFull: boolean;
  streamPartialOutput: boolean;
  verboseTools?: boolean;
  asciiOnly?: boolean;
  queuedInput?: boolean;
  local: boolean;
  yolo: boolean;
  force: boolean;
  approveRules: string[];
  onApproval: OnApproval;
  onApprovalExplicit: boolean;
  strictDangerCheck: boolean;
  iKnowWhatImDoing: boolean;
  username?: string;
  password?: string;
  help: boolean;
  version: boolean;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
}

export function parseRawArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        i += 1;
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
        i += 1;
        continue;
      }
      flags[key] = next;
      i += 2;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (BOOLEAN_SHORT_FLAGS.has(key) || next === undefined || next.startsWith('-')) {
        flags[key] = true;
        i += 1;
        continue;
      }
      flags[key] = next;
      i += 2;
      continue;
    }
    positionals.push(token);
    i += 1;
  }
  return { positionals, flags };
}

function getFlag(flags: Record<string, string | boolean>, ...names: string[]): string | boolean | undefined {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(flags, name) && flags[name] !== undefined) {
      return flags[name];
    }
  }
  return undefined;
}

function optionalString(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  const value = getFlag(flags, ...names);
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function optionalNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new CliError(`参数 --${name} 必须是数字`);
  }
  return num;
}

function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => {
    const v = flags[n];
    return v === true || v === 'true' || v === '1';
  });
}

export function normalizeBaseUrl(raw: string): string {
  let url = String(raw).trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) url = url.slice(0, -3).replace(/\/+$/, '');
  return url;
}

function parseOutputFormat(raw: string | undefined): OutputFormat {
  const v = (raw ?? 'text').toLowerCase();
  if (v === 'text' || v === 'json' || v === 'stream-json') return v;
  throw new CliError(`--output-format 必须是 text|json|stream-json，收到: ${raw}`);
}

function parsePermission(raw: string | undefined): PermissionLevel {
  const v = (raw ?? 'READ_WRITE').toUpperCase();
  if (v === 'READ_ONLY' || v === 'READ_WRITE' || v === 'SMART' || v === 'FULL') return v;
  throw new CliError(`--permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL，收到: ${raw}`);
}

function parseIfRunning(raw: string | undefined): IfRunning {
  const v = (raw ?? 'wait').toLowerCase();
  if (v === 'wait' || v === 'cancel' || v === 'fail') return v;
  throw new CliError(`--if-running 必须是 wait|cancel|fail，收到: ${raw}`);
}

function parseOnQuestion(raw: string | undefined): OnQuestion {
  const v = (raw ?? 'ask').toLowerCase();
  if (v === 'ask' || v === 'fail') return v;
  throw new CliError(`--on-question 必须是 ask|fail，收到: ${raw}`);
}

function parseOnApproval(raw: string | undefined): OnApproval {
  const v = (raw ?? 'ask').toLowerCase();
  if (v === 'ask' || v === 'fail') return v;
  throw new CliError(`--on-approval 必须是 ask|fail，收到: ${raw}`);
}

function collectRepeatable(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === `--${name}`) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) out.push(next);
    } else if (token.startsWith(`--${name}=`)) {
      out.push(token.slice(name.length + 3));
    }
  }
  return out;
}

function parseResume(flags: Record<string, string | boolean>): number | 'latest' | undefined {
  const v = getFlag(flags, 'resume');
  if (v === undefined) return undefined;
  if (v === true) return 'latest';
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`--resume 必须是正整数会话 id，收到: ${v}`);
  }
  return n;
}

export function parseCliConfig(
  argv: string[],
  io: { stdoutIsTty: boolean; stdinIsTty: boolean } = {
    stdoutIsTty: Boolean(process.stdout.isTTY),
    stdinIsTty: Boolean(process.stdin.isTTY),
  },
): CliConfig {
  const { positionals, flags } = parseRawArgs(argv);

  const local = hasFlag(flags, 'local');
  for (const name of LOCAL_APPROVAL_FLAGS) {
    if (name === 'f' || name === 'force' || name === 'yolo' || name === 'approve-rule' || name === 'on-approval' || name === 'strict-danger-check' || name === 'i-know-what-im-doing') {
      if (!local && getFlag(flags, name) !== undefined) {
        throw new CliError(`选项 --${name === 'f' ? 'force' : name} 仅在 --local（LOCAL 模式）下有效`);
      }
    }
  }

  const help = hasFlag(flags, 'help', 'h');
  const version = hasFlag(flags, 'version', 'V');
  const first = positionals[0];

  let command: CommandName = 'chat';
  let rest = positionals;
  if (help && positionals.length === 0) command = 'help';
  else if (version && positionals.length === 0) command = 'version';
  else if (first === 'login' || first === 'logout' || first === 'status' || first === 'ls' || first === 'resume' || first === 'help') {
    command = first;
    rest = positionals.slice(1);
  }

  const pFlag = getFlag(flags, 'p', 'print');
  let promptFromP: string | undefined;
  let print = pFlag !== undefined;
  if (typeof pFlag === 'string') promptFromP = pFlag;

  let prompt = '';
  if (command === 'chat') {
    prompt = [promptFromP, rest.join(' ')].filter(Boolean).join('\n').trim();
  } else if (command === 'resume') {
    prompt = [promptFromP, rest.slice(1).join(' ')].filter(Boolean).join('\n').trim();
  }

  const stdoutIsTty = io.stdoutIsTty;
  const stdinIsTty = io.stdinIsTty;
  const autoPrint = !stdoutIsTty || (!stdinIsTty && !prompt && command === 'chat');
  if (autoPrint && command === 'chat') print = true;

  const outputFormat = parseOutputFormat(
    optionalString(flags, 'output-format') ?? process.env.MAO_AGENT_OUTPUT_FORMAT,
  );

  let resumeSessionId = parseResume(flags);
  if (command === 'resume') {
    const idArg = rest[0];
    if (idArg) {
      const n = Number(idArg);
      if (!Number.isInteger(n) || n <= 0) {
        throw new CliError(`resume 的 sessionId 必须是正整数，收到: ${idArg}`);
      }
      resumeSessionId = n;
    } else {
      resumeSessionId = resumeSessionId ?? 'latest';
    }
  }

  const onQuestionRaw = optionalString(flags, 'on-question');
  let onQuestion = parseOnQuestion(onQuestionRaw);
  if (!onQuestionRaw && print) onQuestion = 'fail';
  if (!stdoutIsTty && !onQuestionRaw) onQuestion = 'fail';

  const onApprovalRaw = optionalString(flags, 'on-approval');
  let onApproval = parseOnApproval(onApprovalRaw);
  if (!onApprovalRaw && (print || !stdoutIsTty)) onApproval = 'fail';

  if (onQuestion === 'ask' && print && !stdoutIsTty) {
    throw new CliError('打印模式在非 TTY 下不允许 --on-question=ask，请改用 --on-question=fail 或在交互终端中使用');
  }
  if (local && onApproval === 'ask' && print && !stdoutIsTty) {
    throw new CliError('LOCAL 打印模式在非 TTY 下不允许 --on-approval=ask，请改用 --on-approval=fail、--yolo，或在交互终端中使用');
  }
  if (local && (optionalString(flags, 'git-clone') || optionalString(flags, 'cloud-project'))) {
    throw new CliError('LOCAL 模式不能使用 --git-clone / --cloud-project（那些是 CLOUD 服务端工作区选项）');
  }

  const timeoutMs = optionalNumber(flags, 'timeout-ms') ?? DEFAULT_TIMEOUT_MS;
  const maxDuration = optionalNumber(flags, 'max-duration');

  let colorFlag: boolean | undefined;
  if (hasFlag(flags, 'no-color') || process.env.NO_COLOR) colorFlag = false;
  else if (hasFlag(flags, 'color')) colorFlag = true;

  return {
    command,
    prompt,
    print,
    outputFormat,
    resumeSessionId,
    continueLast: hasFlag(flags, 'continue'),
    agent: optionalString(flags, 'agent'),
    model: optionalString(flags, 'model'),
    workspace: optionalString(flags, 'workspace'),
    cloudProject: optionalString(flags, 'cloud-project'),
    gitClone: optionalString(flags, 'git-clone'),
    gitBranch: optionalString(flags, 'git-branch'),
    permissionLevel: parsePermission(optionalString(flags, 'permission-level')),
    thinking: hasFlag(flags, 'thinking'),
    ifRunning: parseIfRunning(optionalString(flags, 'if-running')),
    onQuestion,
    onQuestionExplicit: Boolean(onQuestionRaw),
    maxDurationSec: maxDuration,
    timeoutMs,
    baseUrl: optionalString(flags, 'base-url'),
    token: optionalString(flags, 'token'),
    colorFlag,
    debug: hasFlag(flags, 'debug'),
    traceFile: optionalString(flags, 'trace-file'),
    includeToolIo: hasFlag(flags, 'include-tool-io'),
    replayFull: hasFlag(flags, 'replay-full'),
    streamPartialOutput: hasFlag(flags, 'stream-partial-output'),
    verboseTools: hasFlag(flags, 'verbose-tools') ? true : undefined,
    asciiOnly: hasFlag(flags, 'ascii') ? true : undefined,
    queuedInput: hasFlag(flags, 'no-queue') ? false : undefined,
    local,
    yolo: hasFlag(flags, 'yolo'),
    force: hasFlag(flags, 'force', 'f'),
    approveRules: collectRepeatable(argv, 'approve-rule'),
    onApproval,
    onApprovalExplicit: Boolean(onApprovalRaw),
    strictDangerCheck: hasFlag(flags, 'strict-danger-check'),
    iKnowWhatImDoing: hasFlag(flags, 'i-know-what-im-doing'),
    username: optionalString(flags, 'username'),
    password: optionalString(flags, 'password'),
    help,
    version,
    stdoutIsTty,
    stdinIsTty,
  };
}

export const HELP_TEXT = `mao-agent CLI — 无 GUI 终端对话式 Agent 客户端（CLOUD / LOCAL）

用法:
  mao-agent [prompt]                 无参数进入交互式 REPL；带 prompt 则发送首条消息后进入 REPL
  mao-agent --local [prompt]         LOCAL 模式：工具在本机工作区执行
  mao-agent -p "prompt"              打印模式：发一条消息，等任务终态后退出
  mao-agent ls                       列出可恢复的会话
  mao-agent resume [sessionId]       恢复会话；省略 id 则恢复最近更新的一个
  mao-agent login                    用户名密码登录，写入 ~/.mao/auth.json
  mao-agent logout                   清除本地登录态
  mao-agent status                   当前登录用户 / token 剩余有效期 / baseUrl / CLI 版本
  mao-agent --help / --version

全局选项:
  -p, --print                        非交互打印模式
  --output-format <text|json|stream-json>
                                     输出格式，默认 text
  --resume [sessionId]               恢复会话，省略 id 恢复最近更新的一个
  --continue                         恢复本地记录的「上次使用会话」
  --agent <id|name>                  指定 Agent；缺省用 isDefault=true
  --model <id|name>                  指定模型（会持久修改会话模型）
  --workspace <path>                 CLOUD：服务端工作区路径；LOCAL：本机工作区（默认 cwd）
  --cloud-project <key>              复用已存在的服务端项目目录（仅 CLOUD）
  --git-clone <url> --git-branch <b> 建会话时克隆代码到服务端工作区（仅 CLOUD）
  --permission-level <READ_ONLY|READ_WRITE|SMART|FULL>
                                     写入会话记录。CLOUD 下不产生审批；LOCAL 下按下方矩阵决定是否审批
  --thinking                         展开思考内容（默认折叠/抑制）
  --if-running <wait|cancel|fail>    resume 时会话仍在跑的策略，默认 wait
  --on-question <ask|fail>           遇到 ask_user_questions：TTY 默认 ask，非 TTY / 打印模式默认 fail
  --max-duration <sec>               单次任务墙钟上限，超时发 cancel 后退出码 124
  --timeout-ms <n>                   单次 REST 请求超时，默认 30000
  --base-url <url>                   API 根地址（到 /api 为止，不含 /v1）
  --token <jwt>                      一次性覆盖本地 token（建议改用环境变量 MAO_TOKEN，避免进入 shell 历史）
  --no-color / --color               强制禁用 / 强制启用颜色（NO_COLOR 等价于 --no-color）
  --debug                            打印 WS 收发帧与 REST 摘要到 stderr（已脱敏）
  --trace-file <path>                完整事件流落盘为 NDJSON
  --include-tool-io                  json 输出里带上 toolCalls[].arguments / result
  --replay-full                      resume 时完整打印历史消息，默认只打印最后 3 轮精简摘要
  --stream-partial-output            配合 stream-json 逐 delta 输出
  --verbose-tools                    交互模式展开工具输出（默认折叠）
  --ascii                            状态符号改用纯 ASCII（无 emoji / 宽字符）
  --no-queue                         执行中禁止预输入下一条消息

LOCAL 模式选项:
  --local                            本机执行工具（executionMode=LOCAL）
  --yolo, -f, --force                自动放行服务端要求的审批（不豁免工作区信任 / 默认拒绝清单）
  --approve-rule <tool:pattern>      允许匹配的工具，可重复。例: --approve-rule 'shell:ls *'
  --on-approval <ask|fail>           需审批时：TTY 默认 ask，非 TTY / 打印模式默认 fail
  --strict-danger-check              dangerReason 非空时即使 --yolo 也要确认
  --i-know-what-im-doing             豁免默认拒绝清单（rm -rf /、fork bomb、写 ~/.ssh 等）

环境变量:
  MAO_AGENT_BASE_URL                 默认 ${DEFAULT_BASE_URL}
  MAO_TOKEN / MAO_REFRESH_TOKEN      与 mao-cli 同名
  MAO_AGENT_OUTPUT_FORMAT            默认输出格式
  NO_COLOR                           禁用颜色

退出码:
  0   任务成功（COMPLETED）
  1   一般性错误（参数、未登录、网络、session_already_running 未能恢复）
  2   任务失败（FAILED）
  3   任务被取消（Ctrl+C / SIGTERM / /cancel）
  4   需审批但未获授权（仅 LOCAL）
  5   遇到 ask_user_questions 且 --on-question=fail
  124 --max-duration 超时

permissionLevel:

  READ_ONLY   LOCAL: shell/write_file/edit_file/mcp__* 需审批    CLOUD: 无影响
  READ_WRITE  LOCAL: shell/mcp__* 需审批                         CLOUD: 无影响
  SMART       LOCAL: mcp__* 恒需审批；shell 经 LLM 危险性评估    CLOUD: 无影响
  FULL        LOCAL: 全部自动放行                                 CLOUD: 无影响

CLOUD 下 --permission-level 不限制写文件；真要限权请使用工具集受限的 Agent。
LOCAL 工作区信任写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces，--yolo 不能豁免。

会话与元数据管理请使用 mao CLI，例如：
  mao session list --json
  mao agent list
`;

