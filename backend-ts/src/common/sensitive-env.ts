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
  // 按用户短效注入；继承会残留上一身份
  if (key === 'MAO_TOKEN' || key === 'ECP_TOKEN') return true;
  if (key === 'LARKSUITE_CLI_USER_ACCESS_TOKEN') return true;
  return false;
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
