import { CliError } from './util/exit-codes';

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type IfRunning = 'wait' | 'cancel' | 'fail';
export type OnQuestion = 'ask' | 'fail';
export type OnApproval = 'ask' | 'fail';
export type PermissionLevel = 'READ_ONLY' | 'READ_WRITE' | 'SMART' | 'FULL';
export type CommandName =
  | 'login'
  | 'logout'
  | 'status'
  | 'ls'
  | 'resume'
  | 'chat'
  | 'update'
  | 'help'
  | 'version';

export const DEFAULT_BASE_URL = 'https://mao.etarch.cn/api';
export const DEFAULT_TIMEOUT_MS = 30000;

const SUBCOMMANDS: readonly CommandName[] = ['login', 'logout', 'status', 'ls', 'resume', 'update', 'help'];

/**
 * 选项是否吃掉下一个 token：
 * - boolean  从不吃值（`--local 写点东西` 里的中文必须留给 prompt）
 * - value    必须有值，缺值报错
 * - optional 只有下一个 token 不像选项时才吃（`-p` 既可单独用也可带 prompt）
 * - repeat   同 value，但可重复出现，聚合成数组
 */
type FlagKind = 'boolean' | 'value' | 'optional' | 'repeat';
type FlagGroup = '通用' | '输出与诊断' | '会话' | 'LOCAL 模式';

export interface FlagSpec {
  name: string;
  alias?: string;
  kind: FlagKind;
  /** 帮助里的取值占位符 */
  arg?: string;
  group: FlagGroup;
  desc: string;
  /** 是否出现在精简 --help（其余需 --help --all） */
  common?: boolean;
}

/** 选项的唯一定义处：解析与 --help 都从这里生成，避免两边漂移。 */
export const FLAG_SPECS: readonly FlagSpec[] = [
  { name: 'print', alias: 'p', kind: 'optional', arg: '<prompt>', group: '通用', common: true, desc: '打印模式：发一条消息，等任务终态后退出' },
  { name: 'local', kind: 'boolean', group: '通用', common: true, desc: '工具在本机工作区执行（executionMode=LOCAL）' },
  { name: 'agent', kind: 'value', arg: '<id|name>', group: '通用', common: true, desc: '指定 Agent；缺省用 isDefault=true 的那个' },
  { name: 'model', kind: 'value', arg: '<id|name>', group: '通用', common: true, desc: '指定模型（会持久修改会话模型）' },
  { name: 'workspace', kind: 'value', arg: '<path>', group: '通用', common: true, desc: 'CLOUD：服务端工作区路径；LOCAL：本机工作区（默认 cwd）' },
  { name: 'thinking', kind: 'boolean', group: '通用', desc: '展开思考内容（默认折叠），REPL 里可用 /thinking 切换' },
  { name: 'ascii', kind: 'boolean', group: '通用', desc: '纯 ASCII 输出：直角边框 + 无 emoji/宽字符' },
  { name: 'color', kind: 'boolean', group: '通用', desc: '强制启用颜色' },
  { name: 'no-color', kind: 'boolean', group: '通用', desc: '强制禁用颜色（等价于 NO_COLOR=1）' },
  { name: 'help', alias: 'h', kind: 'boolean', group: '通用', common: true, desc: '显示帮助；--help --all 显示全部选项与退出码' },
  { name: 'all', kind: 'boolean', group: '通用', desc: '与 --help 连用时输出完整帮助' },
  { name: 'version', alias: 'V', kind: 'boolean', group: '通用', desc: '显示版本号' },

  { name: 'resume', kind: 'optional', arg: '<sessionId>', group: '会话', common: true, desc: '恢复会话；省略 id 恢复最近更新的一个' },
  { name: 'continue', kind: 'boolean', group: '会话', common: true, desc: '恢复本地记录的「上次使用会话」' },
  { name: 'permission-level', kind: 'value', arg: '<level>', group: '会话', desc: 'READ_ONLY|READ_WRITE|SMART|FULL，写入会话；只影响 LOCAL 审批' },
  { name: 'if-running', kind: 'value', arg: '<wait|cancel|fail>', group: '会话', desc: '目标会话仍在跑时的策略，默认 wait' },
  { name: 'on-question', kind: 'value', arg: '<ask|fail>', group: '会话', desc: '遇到 ask_user_questions：TTY 默认 ask，打印/非 TTY 默认 fail' },
  { name: 'max-duration', kind: 'value', arg: '<sec>', group: '会话', desc: '单次任务墙钟上限，超时发 cancel 并以 124 退出' },
  { name: 'cloud-project', kind: 'value', arg: '<key>', group: '会话', desc: '复用已存在的服务端项目目录（仅 CLOUD）' },
  { name: 'git-clone', kind: 'value', arg: '<url>', group: '会话', desc: '建会话时克隆仓库到服务端工作区（仅 CLOUD）' },
  { name: 'git-branch', kind: 'value', arg: '<branch>', group: '会话', desc: '配合 --git-clone 指定分支' },
  { name: 'no-queue', kind: 'boolean', group: '会话', desc: '执行中禁止预输入下一条消息（默认允许排队）' },

  { name: 'output-format', kind: 'value', arg: '<text|json|stream-json>', group: '输出与诊断', common: true, desc: '输出格式，默认 text' },
  { name: 'verbose-tools', kind: 'boolean', group: '输出与诊断', desc: '交互模式展开工具输出（默认折叠），REPL 里可用 /verbose 切换' },
  { name: 'include-tool-io', kind: 'boolean', group: '输出与诊断', desc: 'json 输出带上 toolCalls[].arguments / result' },
  { name: 'stream-partial-output', kind: 'boolean', group: '输出与诊断', desc: '配合 stream-json 逐 delta 输出' },
  { name: 'replay-full', kind: 'boolean', group: '输出与诊断', desc: 'resume 时完整打印历史消息，默认只摘要最后 3 轮' },
  { name: 'debug', kind: 'boolean', group: '输出与诊断', desc: '打印 WS 收发帧与 REST 摘要到 stderr（已脱敏）' },
  { name: 'trace-file', kind: 'value', arg: '<path>', group: '输出与诊断', desc: '完整事件流落盘为 NDJSON' },
  { name: 'base-url', kind: 'value', arg: '<url>', group: '输出与诊断', desc: 'API 根地址（到 /api 为止，不含 /v1）' },
  { name: 'token', kind: 'value', arg: '<jwt>', group: '输出与诊断', desc: '一次性覆盖本地 token（更推荐环境变量 MAO_TOKEN）' },
  { name: 'timeout-ms', kind: 'value', arg: '<n>', group: '输出与诊断', desc: `单次 REST 请求超时，默认 ${DEFAULT_TIMEOUT_MS}` },

  { name: 'yolo', kind: 'boolean', group: 'LOCAL 模式', common: true, desc: '自动放行服务端要求的审批（不豁免工作区信任与默认拒绝清单）' },
  { name: 'force', alias: 'f', kind: 'boolean', group: 'LOCAL 模式', desc: '同 --yolo' },
  { name: 'approve-rule', kind: 'repeat', arg: '<tool:pattern>', group: 'LOCAL 模式', desc: "放行匹配的工具，可重复。例: --approve-rule 'shell:ls *'" },
  { name: 'on-approval', kind: 'value', arg: '<ask|fail>', group: 'LOCAL 模式', desc: '需审批时：TTY 默认 ask，打印/非 TTY 默认 fail' },
  { name: 'strict-danger-check', kind: 'boolean', group: 'LOCAL 模式', desc: 'dangerReason 非空时即使 --yolo 也必须人工确认' },
  { name: 'i-know-what-im-doing', kind: 'boolean', group: 'LOCAL 模式', desc: '豁免默认拒绝清单（rm -rf /、fork bomb、写 ~/.ssh 等）' },

  { name: 'username', kind: 'value', arg: '<name>', group: '通用', desc: 'login 用户名（缺省交互询问）' },
  { name: 'password', kind: 'value', arg: '<pwd>', group: '通用', desc: 'login 密码（缺省隐藏输入；避免进 shell 历史）' },
  { name: 'check', kind: 'boolean', group: '通用', desc: 'update：只检查远端新版本，不安装' },
  { name: 'ref', kind: 'value', arg: '<git-ref>', group: '通用', desc: 'update：指定分支/标签' },
  { name: 'repo', kind: 'value', arg: '<url>', group: '通用', desc: 'update：指定仓库源' },
  { name: 'src-dir', kind: 'value', arg: '<path>', group: '通用', desc: 'update：指定本地源码目录' },
];

const SPEC_BY_NAME = new Map<string, FlagSpec>();
const SPEC_BY_ALIAS = new Map<string, FlagSpec>();
for (const spec of FLAG_SPECS) {
  SPEC_BY_NAME.set(spec.name, spec);
  if (spec.alias) SPEC_BY_ALIAS.set(spec.alias, spec);
}

/** LOCAL 专属选项：没有 --local 时使用属于配置错误，直接报错而不是静默忽略。 */
export const LOCAL_ONLY_FLAGS: readonly string[] = FLAG_SPECS
  .filter((s) => s.group === 'LOCAL 模式')
  .map((s) => s.name);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  repeated: Record<string, string[]>;
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
  updateRef?: string;
  updateRepo?: string;
  updateSrcDir?: string;
  updateCheck: boolean;
  help: boolean;
  helpAll: boolean;
  version: boolean;
  consumesPipedPrompt: boolean;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
}

function nearestFlags(token: string): string[] {
  const bare = token.replace(/^-+/, '').split('=')[0].toLowerCase();
  if (!bare) return [];
  return FLAG_SPECS
    .map((s) => s.name)
    .filter((name) => name.startsWith(bare.slice(0, 3)) || name.includes(bare))
    .slice(0, 3);
}

function unknownFlag(token: string): never {
  const near = nearestFlags(token);
  throw new CliError(
    `未知选项 ${token}` + (near.length ? `。是否想用 ${near.map((n) => `--${n}`).join(' / ')}？` : '') + '（--help 查看全部）',
  );
}

function parseBooleanValue(spec: FlagSpec, raw: string): boolean {
  const v = raw.toLowerCase();
  if (v === '' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new CliError(`选项 --${spec.name} 是开关，不接受值「${raw}」`);
}

/** 下一个 token 是否是「另一个选项」——用于判断 value 型选项是否缺值。 */
function looksLikeFlag(token: string | undefined): boolean {
  if (token === undefined) return true;
  if (token === '--') return true;
  if (!token.startsWith('-') || token === '-') return false;
  const bare = token.replace(/^--?/, '').split('=')[0];
  return SPEC_BY_NAME.has(bare) || (token.startsWith('-') && !token.startsWith('--') && SPEC_BY_ALIAS.has(bare));
}

export function parseRawArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};

  const take = (spec: FlagSpec, token: string, inlineValue: string | undefined, next: string | undefined): boolean => {
    if (spec.kind === 'boolean') {
      flags[spec.name] = inlineValue === undefined ? true : parseBooleanValue(spec, inlineValue);
      return false;
    }
    if (inlineValue !== undefined) {
      if (spec.kind === 'repeat') (repeated[spec.name] ??= []).push(inlineValue);
      else flags[spec.name] = inlineValue;
      return false;
    }
    if (spec.kind === 'optional') {
      if (next === undefined || next.startsWith('-')) {
        flags[spec.name] = true;
        return false;
      }
      flags[spec.name] = next;
      return true;
    }
    if (looksLikeFlag(next)) {
      throw new CliError(`选项 ${token} 缺少值${spec.arg ? `（${spec.arg}）` : ''}`);
    }
    if (spec.kind === 'repeat') (repeated[spec.name] ??= []).push(next as string);
    else flags[spec.name] = next as string;
    return true;
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const spec = SPEC_BY_NAME.get(name);
      if (!spec) unknownFlag(token);
      i += take(spec, token, inline, argv[i + 1]) ? 2 : 1;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const eq = token.indexOf('=');
      const key = eq === -1 ? token.slice(1) : token.slice(1, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const spec = SPEC_BY_ALIAS.get(key) ?? (key.length > 1 ? SPEC_BY_NAME.get(key) : undefined);
      if (!spec) unknownFlag(token);
      i += take(spec, token, inline, argv[i + 1]) ? 2 : 1;
      continue;
    }
    positionals.push(token);
    i += 1;
  }
  return { positionals, flags, repeated };
}

function optionalString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function positiveInt(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new CliError(`选项 --${name} 必须是正整数，收到: ${value}`);
  }
  return num;
}

function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags[n] === true);
}

/**
 * 该命令是否消费管道提示词（决定非 TTY 下是否读 stdin）。
 * chat（裸调用、-p、带 prompt 参数）支持管道输入；子命令不读 stdin，
 * 否则在保持 stdin 打开的环境（Agent 持久 shell、CI）里会无限挂起。
 */
export function consumesPipedPrompt(command: CommandName): boolean {
  return command === 'chat';
}

export function normalizeBaseUrl(raw: string): string {
  let url = String(raw).trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) url = url.slice(0, -3).replace(/\/+$/, '');
  return url;
}

function parseEnum<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T, normalize: (s: string) => string): T {
  if (raw === undefined) return fallback;
  const v = normalize(raw) as T;
  if (allowed.includes(v)) return v;
  throw new CliError(`--${name} 必须是 ${allowed.join('|')}，收到: ${raw}`);
}

const lower = (s: string) => s.toLowerCase();
const upper = (s: string) => s.toUpperCase();

function parseResume(flags: Record<string, string | boolean>): number | 'latest' | undefined {
  const v = flags['resume'];
  if (v === undefined) return undefined;
  if (v === true) return 'latest';
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`--resume 必须是正整数会话 id，收到: ${String(v)}`);
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
  const { positionals, flags, repeated } = parseRawArgs(argv);

  const local = hasFlag(flags, 'local');
  if (!local) {
    for (const name of LOCAL_ONLY_FLAGS) {
      if (flags[name] !== undefined || repeated[name] !== undefined) {
        throw new CliError(`选项 --${name} 仅在 --local（LOCAL 模式）下有效`);
      }
    }
  }

  const help = hasFlag(flags, 'help');
  const version = hasFlag(flags, 'version');
  const first = positionals[0];

  let command: CommandName = 'chat';
  let rest = positionals;
  if (help && positionals.length === 0) command = 'help';
  else if (version && positionals.length === 0) command = 'version';
  else if (first && (SUBCOMMANDS as readonly string[]).includes(first)) {
    command = first as CommandName;
    rest = positionals.slice(1);
  }

  const pFlag = flags['print'];
  const promptFromP = typeof pFlag === 'string' ? pFlag : undefined;
  let print = pFlag !== undefined;

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

  const outputFormat = parseEnum(
    'output-format',
    optionalString(flags, 'output-format') ?? process.env.MAO_AGENT_OUTPUT_FORMAT ?? undefined,
    ['text', 'json', 'stream-json'] as const,
    'text',
    lower,
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
  let onQuestion = parseEnum('on-question', onQuestionRaw, ['ask', 'fail'] as const, 'ask', lower);
  if (!onQuestionRaw && (print || !stdoutIsTty)) onQuestion = 'fail';

  const onApprovalRaw = optionalString(flags, 'on-approval');
  let onApproval = parseEnum('on-approval', onApprovalRaw, ['ask', 'fail'] as const, 'ask', lower);
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
    permissionLevel: parseEnum(
      'permission-level',
      optionalString(flags, 'permission-level'),
      ['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL'] as const,
      'READ_WRITE',
      upper,
    ),
    thinking: hasFlag(flags, 'thinking'),
    ifRunning: parseEnum('if-running', optionalString(flags, 'if-running'), ['wait', 'cancel', 'fail'] as const, 'wait', lower),
    onQuestion,
    onQuestionExplicit: Boolean(onQuestionRaw),
    maxDurationSec: positiveInt(flags, 'max-duration'),
    timeoutMs: positiveInt(flags, 'timeout-ms') ?? DEFAULT_TIMEOUT_MS,
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
    force: hasFlag(flags, 'force'),
    approveRules: repeated['approve-rule'] ?? [],
    onApproval,
    onApprovalExplicit: Boolean(onApprovalRaw),
    strictDangerCheck: hasFlag(flags, 'strict-danger-check'),
    iKnowWhatImDoing: hasFlag(flags, 'i-know-what-im-doing'),
    username: optionalString(flags, 'username'),
    password: optionalString(flags, 'password'),
    updateRef: optionalString(flags, 'ref'),
    updateRepo: optionalString(flags, 'repo'),
    updateSrcDir: optionalString(flags, 'src-dir'),
    updateCheck: hasFlag(flags, 'check'),
    help,
    helpAll: hasFlag(flags, 'all'),
    version,
    consumesPipedPrompt: consumesPipedPrompt(command),
    stdoutIsTty,
    stdinIsTty,
  };
}

const USAGE = `用法:
  mao-agent [prompt]                 无参数进入交互式 REPL；带 prompt 则先发首条消息
  mao-agent --local [prompt]         LOCAL 模式：工具在本机工作区执行
  mao-agent -p "prompt"              打印模式：发一条消息，等任务终态后退出
  mao-agent resume [sessionId]       恢复会话；省略 id 则恢复最近更新的一个
  mao-agent ls                       列出可恢复的会话
  mao-agent login | logout | status  登录 / 登出 / 查看登录态与 baseUrl
  mao-agent update [--check]         拉取最新源码并重装；--check 仅检查新版本`;

const REFERENCE = `环境变量:
  MAO_AGENT_BASE_URL                 默认 ${DEFAULT_BASE_URL}
  MAO_TOKEN / MAO_REFRESH_TOKEN      与 mao CLI 同名（兼容 MAO_ADMIN_* / MAO_USER_*）
  MAO_AGENT_OUTPUT_FORMAT            默认输出格式
  MAO_AGENT_VERBOSE                  1/true 默认展开工具输出，0/false 强制折叠
  MAO_AGENT_REPO / MAO_AGENT_REF     update 默认仓库与分支（等价 --repo / --ref）
  NO_COLOR                           禁用颜色

配置文件（优先级：命令行 > 环境变量 > 项目配置 > 用户配置 > 内置默认）:
  ~/.mao/auth.json                   JWT，与 mao CLI 共用（0600）
  ~/.mao/agent-cli/config.json       用户配置与 trustedWorkspaces（0600）
  ~/.mao/agent-cli/history           输入历史，最近 200 条（0600）
  <项目>/.mao/agent.json             项目级配置，向上查找到 git 根为止

互斥与默认:
  --local 与 --git-clone / --cloud-project 互斥
  -p 且非 TTY 时显式 --on-approval=ask 会报错（无处弹审批）
  --permission-level 缺省 READ_WRITE，会写入会话并覆盖服务端默认（服务端默认 READ_ONLY）

stdin: chat（裸调用 / -p / 带 prompt）在非 TTY 下读取管道提示词，读到 EOF 即结算，2s 内无输入则跳过；子命令不读 stdin。

退出码:
  0   任务成功（COMPLETED）
  1   一般性错误（参数、未登录、网络、session_already_running 未能恢复）
  2   任务失败（FAILED）
  3   任务被取消（Ctrl+C / SIGTERM / /cancel）
  4   需审批但未获授权（仅 LOCAL）
  5   遇到 ask_user_questions 且 --on-question=fail
  124 --max-duration 超时

permissionLevel（只影响 LOCAL 审批，CLOUD 下不限制写文件）:
  READ_ONLY   shell / write_file / edit_file / mcp__* 需审批
  READ_WRITE  shell / mcp__* 需审批
  SMART       mcp__* 恒需审批；shell 经 LLM 危险性评估
  FULL        全部自动放行

CLOUD 要限权请改用工具集受限的 Agent。

LOCAL 边界（仅 --local）:
  沙箱             文件读写、glob/grep 搜索根、shell 的 workdir 必须落在信任工作区或本会话 runtime 内；
                   ../ 越界、外部绝对路径、指向外部的符号链接一律拒绝
  工作区权威       服务端下发的 workspace 只能等于本地工作区或位于其内部
  审批链           工作区信任（含读类工具，--yolo 不豁免）→ 默认拒绝清单（--i-know-what-im-doing 可豁免）
                   → --approve-rule → 本会话「总是允许」的精确条目 → --yolo/--force → TTY 确认；
                   shell 每次 exec / write_stdin 与每个 MCP stdio 启动各过一遍
  运行前提         shell 固定用 bash（缺失即报错）；子进程不含 MAO_TOKEN，需自行 mao login
  信任存储         ~/.mao/agent-cli/config.json 的 trustedWorkspaces

会话与元数据管理请使用 mao CLI（mao session list --json / mao agent list）。`;

function flagLabel(spec: FlagSpec): string {
  const arg = spec.arg ? (spec.kind === 'optional' ? ` [${spec.arg.replace(/^<|>$/g, '')}]` : ` ${spec.arg}`) : '';
  const long = `--${spec.name}${arg}`;
  return spec.alias ? `-${spec.alias}, ${long}` : `    ${long}`;
}

/**
 * 渲染帮助。默认只列常用选项（一屏内可读完），--help --all 输出全部选项与参考信息。
 */
export function formatHelp(all = false): string {
  const groups: FlagGroup[] = ['通用', '会话', '输出与诊断', 'LOCAL 模式'];
  const shown = FLAG_SPECS.filter((s) => all || s.common);
  const labels = new Map(shown.map((s) => [s.name, flagLabel(s)]));
  const width = Math.min(38, Math.max(...[...labels.values()].map((l) => l.length)) + 2);
  const sections: string[] = [];
  for (const group of groups) {
    const items = shown.filter((s) => s.group === group);
    if (items.length === 0) continue;
    const lines = items.map((s) => {
      const label = labels.get(s.name) as string;
      return label.length >= width
        ? `  ${label}\n  ${' '.repeat(width)}${s.desc}`
        : `  ${label}${' '.repeat(width - label.length)}${s.desc}`;
    });
    sections.push(`${group}:\n${lines.join('\n')}`);
  }
  const head = 'mao-agent — 终端里的 Mao Agent 客户端（CLOUD 服务端执行 / LOCAL 本机执行）';
  const tail = all ? REFERENCE : '更多选项与退出码: mao-agent --help --all';
  return [head, '', USAGE, '', ...sections, '', tail, ''].join('\n');
}
