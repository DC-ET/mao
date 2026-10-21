/**
 * 子进程（Agent Shell / 云端终端）不得从 process.env 继承的键：
 * 启动链路会把运维 shell 与 .env 整包带进后端，全量透传会把
 * 他人 GIT_TOKEN、加解密主密钥等泄漏给任意用户的会话。
 */
export function isSensitiveChildEnvKey(key: string): boolean {
  if (key.startsWith('GIT_TOKEN_')) return true;
  if (key === 'GIT_ASKPASS' || key === 'GIT_TERMINAL_PROMPT') return true;
  if (key === 'APP_GIT_CREDENTIAL_SECRET') return true;
  if (key === 'JWT_SECRET') return true;
  if (key.startsWith('MYSQL_')) return true;
  if (key === 'APP_NOTIFICATION_WEBHOOK_SECRET' || key === 'APP_MCP_SECRET') return true;
  // 新旧两个名字都要剥离：旧部署仍可能配置 APP_USER_TOOL_SECRET（设计 §5.12 不改名）。
  if (key === 'APP_HTTP_TOOL_SECRET' || key === 'APP_USER_TOOL_SECRET') return true;
  // 非 APP_ 前缀的平台主密钥/集成密钥：settings 加密主密钥与钉钉 OAuth secret
  if (key === 'SETTINGS_SECRET' || key === 'DINGTALK_OAUTH_SECRET') return true;
  // 按用户短效注入；继承会残留上一身份
  if (key === 'MAO_TOKEN' || key === 'ECP_TOKEN') return true;
  if (key === 'LARKSUITE_CLI_USER_ACCESS_TOKEN') return true;
  return false;
}

/**
 * 用户 / 工作区 / 系统三层环境变量禁止覆盖的键（技术方案 §5.3）。
 *
 * 三类：
 * - 平台凭据：与 isSensitiveChildEnvKey 对齐，避免用户配置覆盖当前身份注入值；
 * - shell / 进程基础键：改这些键可影响子进程加载行为（LD_PRELOAD / NODE_OPTIONS /
 *   BASH_ENV / PYTHONPATH 等同任意代码执行），或破坏 shell 自身（PATH / HOME / IFS）；
 * - deps / 任务注入键：由平台按会话计算，用户覆盖会让依赖持久化落到错误目录。
 *
 * 前缀黑名单按 toUpperCase 比较：`path` / `Path` 一律拒，避免大小写变体绕过。
 * 注意 `MAO_` 必须整体禁：sanitizeInheritedEnv 是黑名单剥离，MAO_WORKSPACE_ROOT 等
 * 平台自研键会原样继承进子进程，允许用户配置会被 Agent 侧读取代码路径读到。
 */
const RESERVED_ENV_KEYS = new Set([
  // 平台凭据（与 isSensitiveChildEnvKey 对齐）
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'APP_GIT_CREDENTIAL_SECRET', 'JWT_SECRET',
  'MAO_TOKEN', 'ECP_TOKEN', 'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_APP_ID',
  // shell / 进程基础键
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM',
  'LANG', 'LC_ALL', 'TMPDIR', 'IFS', 'PS1', 'PS2', 'PS4', 'BASH', 'BASHOPTS', 'BASH_ENV',
  'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PYTHONSTARTUP', 'PYTHONPATH',
  'MAO_TASK_NAME', 'MAO_DEPS_BIN', 'NPM_CONFIG_PREFIX', 'PIP_TARGET', 'PIP_BREAK_SYSTEM_PACKAGES',
]);

const RESERVED_ENV_PREFIXES = ['GIT_TOKEN_', 'MYSQL_', 'APP_', 'MAO_'];

/** 是否为用户不可配置的保留键（精确命中或前缀命中，大小写不敏感）。 */
export function isReservedEnvKey(key: string): boolean {
  if (key == null || key === '') return false;
  const upper = key.toUpperCase();
  if (RESERVED_ENV_KEYS.has(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** 复制 base 并去掉敏感键；后续只注入当前用户的凭据。 */
export function sanitizeInheritedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (isSensitiveChildEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}
