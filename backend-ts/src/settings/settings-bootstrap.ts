import { hasText } from '../common/case.js';
import { encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type { SystemSettingRepository } from './types.js';

export interface SettingsBootstrapEntry {
  settingKey: string;
  envName: string;
  secret?: boolean;
}

/**
 * 首次导入映射：仅当 DB 行 value 为 NULL（从未设置）且对应环境变量有值时写入。
 * 管理员在后台保存过（包括显式清空为 ''）的行永不覆盖，保证幂等。
 */
export const SETTINGS_BOOTSTRAP_ENTRIES: SettingsBootstrapEntry[] = [
  { settingKey: 'auth.ldap.enabled', envName: 'LDAP_ENABLED' },
  { settingKey: 'auth.ldap.url', envName: 'LDAP_URL' },
  { settingKey: 'auth.ldap.baseDn', envName: 'LDAP_BASE_DN' },
  { settingKey: 'auth.ldap.userDn', envName: 'LDAP_USER_DN' },
  { settingKey: 'auth.ldap.password', envName: 'LDAP_PASSWORD', secret: true },
  { settingKey: 'auth.ldap.userSearchBase', envName: 'LDAP_USER_SEARCH_BASE' },
  { settingKey: 'auth.feishu.enabled', envName: 'FEISHU_ENABLED' },
  { settingKey: 'auth.feishu.appId', envName: 'FEISHU_APP_ID' },
  { settingKey: 'auth.feishu.appSecret', envName: 'FEISHU_APP_SECRET', secret: true },
  { settingKey: 'auth.feishu.redirectUri', envName: 'FEISHU_REDIRECT_URI' },
  { settingKey: 'dingtalk.oauth.clientId', envName: 'DINGTALK_OAUTH_CLIENT_ID' },
  { settingKey: 'dingtalk.oauth.clientSecret', envName: 'DINGTALK_OAUTH_SECRET', secret: true },
  { settingKey: 'dingtalk.oauth.redirectUri', envName: 'DINGTALK_OAUTH_REDIRECT_URI' },
  { settingKey: 'upload.storageMode', envName: 'UPLOAD_STORAGE_MODE' },
  { settingKey: 'upload.baseUrl', envName: 'UPLOAD_BASE_URL' },
  { settingKey: 'file.maxSizeMb', envName: 'FILE_MAX_SIZE_MB' },
  { settingKey: 'tools.tavilyApiKey', envName: 'TAVILY_API_KEY', secret: true },
  { settingKey: 'tools.webSearchProvider', envName: 'WEB_SEARCH_PROVIDER' },
  { settingKey: 'tools.tinyfishApiKey', envName: 'TINYFISH_API_KEY', secret: true },
  { settingKey: 'oss.region', envName: 'OSS_REGION' },
  { settingKey: 'oss.accessKeyId', envName: 'OSS_ACCESS_KEY_ID' },
  { settingKey: 'oss.accessKeySecret', envName: 'OSS_ACCESS_KEY_SECRET', secret: true },
  { settingKey: 'oss.bucket', envName: 'OSS_BUCKET' },
  // oss.sts.* 八项（V093）随 STS 直传废弃，不再引导导入（V201）
  { settingKey: 'cos.region', envName: 'COS_REGION' },
  { settingKey: 'cos.secretId', envName: 'COS_SECRET_ID' },
  { settingKey: 'cos.secretKey', envName: 'COS_SECRET_KEY', secret: true },
  { settingKey: 'cos.bucket', envName: 'COS_BUCKET' },
  { settingKey: 'obs.endpoint', envName: 'OBS_ENDPOINT' },
  { settingKey: 'obs.accessKeyId', envName: 'OBS_ACCESS_KEY_ID' },
  { settingKey: 'obs.accessKeySecret', envName: 'OBS_ACCESS_KEY_SECRET', secret: true },
  { settingKey: 'obs.bucket', envName: 'OBS_BUCKET' },
  { settingKey: 'agent.threadPoolSize', envName: 'AGENT_THREAD_POOL_SIZE' },
  { settingKey: 'agent.threadPoolMax', envName: 'AGENT_THREAD_POOL_MAX' },
  { settingKey: 'agent.threadPoolQueue', envName: 'AGENT_THREAD_POOL_QUEUE' },
  { settingKey: 'ws.idleTimeoutMs', envName: 'APP_WS_IDLE_TIMEOUT_MS' },
  { settingKey: 'notify.workerDelayMs', envName: 'TASK_NOTIFICATION_WORKER_DELAY_MS' },
  { settingKey: 'notify.batchSize', envName: 'TASK_NOTIFICATION_BATCH_SIZE' },
  { settingKey: 'notify.maxAttempts', envName: 'TASK_NOTIFICATION_MAX_ATTEMPTS' },
  // 清理时效（V202）：TTL 迁移不种值（NULL），存量部署的 env 在此一次性导入 DB，此后后台可调
  { settingKey: 'harness.cleanup.browserReplayTtlDays', envName: 'MAO_CLEANUP_BROWSER_REPLAY_DAYS' },
  { settingKey: 'harness.cleanup.shellOutputMaxAgeDays', envName: 'MAO_CLEANUP_SHELL_MAX_AGE_DAYS' },
];

/**
 * 启动时将仍在生效的环境变量值一次性导入 system_setting（此后环境变量对本批配置不再生效）。
 * 失败不阻断启动：单个条目失败仅记录日志。
 */
export async function runSettingsBootstrap(
  repo: Pick<SystemSettingRepository, 'findByKey' | 'updateById'>,
  secretKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  for (const entry of SETTINGS_BOOTSTRAP_ENTRIES) {
    try {
      const row = await repo.findByKey(entry.settingKey);
      if (row == null || row.value != null) {
        continue;
      }
      const envValue = env[entry.envName];
      if (!hasText(envValue)) {
        continue;
      }
      if (entry.secret && !hasText(secretKey)) {
        console.warn(`SettingsBootstrap: SETTINGS_SECRET 未配置，跳过导入加密配置项 ${entry.settingKey}（可稍后在管理后台填写）`);
        continue;
      }
      row.value = entry.secret ? encryptAesGcmNonNull(envValue!, secretKey) : envValue!;
      await repo.updateById(row);
      console.info(`SettingsBootstrap: imported ${entry.settingKey} from ${entry.envName}${entry.secret ? ' (encrypted)' : ''}`);
    } catch (e) {
      console.warn(`SettingsBootstrap: import ${entry.settingKey} failed`, e);
    }
  }
}
