import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface AppConfig {
  server: {
    port: number;
    servlet: { contextPath: string };
  };
  spring: {
    datasource: {
      url: string;
      username: string;
      password: string;
      hikari: {
        maximumPoolSize: number;
        minimumIdle: number;
        connectionTimeout: number;
        idleTimeout: number;
        maxLifetime: number;
      };
    };
    flyway: {
      enabled: boolean;
      baselineOnMigrate: boolean;
      baselineVersion: string;
      validateOnMigrate: boolean;
      locations: string;
    };
  };
  jwt: {
    secret: string;
    expiration: number;
    refreshExpiration: number;
    shellExpiration: number;
  };
  ldap: {
    enabled: boolean;
    url: string;
    baseDn: string;
    userDn: string;
    password: string;
    userSearchBase: string;
  };
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    redirectUri: string;
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    appTokenUrl: string;
  };
  app: {
    rootDir: string;
    gitCredential: { secretKey: string };
    upload: { storageMode: string; baseUrl: string };
    file: { uploadDir: string; maxSizeMb: number };
    ws: { idleTimeoutMs: number; outboundQueueCapacity: number };
    taskNotification: {
      secretKey: string;
      workerDelayMs: number;
      batchSize: number;
      maxAttempts: number;
    };
    harness: {
      workspaceRoot: string;
      runtimeDir: string;
      userHomeDir: string;
      maxConcurrentAgents: number;
      agentThreadPoolSize: number;
      agentThreadPoolMax: number;
      agentThreadPoolQueue: number;
      defaultMaxRounds: number;
      defaultContextRounds: number;
      localToolTimeoutSeconds: number;
      skillsDir: string;
      userSkillsDir: string;
      skillsCacheSeconds: number;
      compaction: {
        enabled: boolean;
        contextWindowTokens: number;
        triggerRatio: number;
        maxSummaryTokens: number;
        loopMidwayCompact: boolean;
      };
      llm: {
        rateLimitMaxRetries: number;
        rateLimitRetryDelaySeconds: number;
        rateLimitMaxRetryDelaySeconds: number;
        callTimeoutSeconds: number;
        httpCallTimeoutSeconds: number;
        streamIdleTimeoutSeconds: number;
      };
      tavily: {
        apiKey: string;
        baseUrl: string;
        connectTimeout: number;
        readTimeout: number;
        maxResults: number;
      };
      webPage: {
        connectTimeout: number;
        readTimeout: number;
        maxRawBytes: number;
        maxOutputLength: number;
        userAgent: string;
      };
      shell: {
        maxSessionsPerConversation: number;
        sessionIdleTimeoutMinutes: number;
        sessionMaxLifetimeHours: number;
        output: { maxPreviewLines: number; maxPreviewChars: number };
      };
    };
    mcp: {
      secretKey: string;
      clientTimeoutSeconds: number;
      syncTimeoutSeconds: number;
    };
  };
  weixin: {
    bot: {
      enabled: boolean;
      voiceReply: boolean;
      silkEncoderPath: string;
      ffmpegPath: string;
      voiceMaxSeconds: number;
      ilinkBaseUrl: string;
      cdnBaseUrl: string;
      maxInboundFileMb: number;
      monitor: {
        enabled: boolean;
        reconcileIntervalMs: number;
        longPollTimeoutMs: number;
        maxConsecutiveFailures: number;
      };
    };
  };
  oss: {
    region: string;
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    maxKeys: number;
    sts: {
      regionId: string;
      endpoint: string;
      accessKeyId: string;
      accessKeySecret: string;
      roleArn: string;
      roleSessionName: string;
      expire: number;
      maxSizeMb: number;
    };
  };
}

const DEFAULTS: AppConfig = {
  server: {
    port: 9080,
    servlet: { contextPath: '/api' },
  },
  spring: {
    datasource: {
      url: 'jdbc:mysql://127.0.0.1:3306/mao?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true',
      username: 'root',
      password: '',
      hikari: {
        maximumPoolSize: 20,
        minimumIdle: 5,
        connectionTimeout: 10000,
        idleTimeout: 300000,
        maxLifetime: 600000,
      },
    },
    flyway: {
      enabled: true,
      baselineOnMigrate: true,
      baselineVersion: '12',
      validateOnMigrate: false,
      locations: 'filesystem:db/migration',
    },
  },
  jwt: {
    secret: 'mao-dev-jwt-secret-change-me-32bytes!!',
    expiration: 86400000,
    refreshExpiration: 604800000,
    shellExpiration: 7200000,
  },
  ldap: {
    enabled: false,
    url: '',
    baseDn: '',
    userDn: '',
    password: '',
    userSearchBase: 'ou=users',
  },
  feishu: {
    enabled: false,
    appId: '',
    appSecret: '',
    redirectUri: 'http://localhost:9080/api/v1/auth/feishu/callback',
    authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
    userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    appTokenUrl: 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
  },
  app: {
    rootDir: '/opt/mao',
    gitCredential: { secretKey: '' },
    upload: { storageMode: 'local', baseUrl: '' },
    file: { uploadDir: './uploads', maxSizeMb: 50 },
    ws: { idleTimeoutMs: 90000, outboundQueueCapacity: 10000 },
    taskNotification: {
      secretKey: 'mao-task-notification-default-key-v1-20260713',
      workerDelayMs: 30000,
      batchSize: 100,
      maxAttempts: 4,
    },
    harness: {
      workspaceRoot: './workspace',
      runtimeDir: '/opt/mao/data/runtime',
      userHomeDir: '/opt/mao/data/users',
      maxConcurrentAgents: 20,
      agentThreadPoolSize: 20,
      agentThreadPoolMax: 100,
      agentThreadPoolQueue: 200,
      defaultMaxRounds: 0,
      defaultContextRounds: 0,
      localToolTimeoutSeconds: 900,
      skillsDir: './skills',
      userSkillsDir: join(process.env.HOME ?? '/tmp', '.mao/data/userskills'),
      skillsCacheSeconds: 300,
      compaction: {
        enabled: true,
        contextWindowTokens: 256000,
        triggerRatio: 0.8,
        maxSummaryTokens: 12000,
        loopMidwayCompact: true,
      },
      llm: {
        rateLimitMaxRetries: 10,
        rateLimitRetryDelaySeconds: 2,
        rateLimitMaxRetryDelaySeconds: 30,
        callTimeoutSeconds: 120,
        httpCallTimeoutSeconds: 180,
        streamIdleTimeoutSeconds: 300,
      },
      tavily: {
        apiKey: '',
        baseUrl: 'https://api.tavily.com',
        connectTimeout: 10000,
        readTimeout: 30000,
        maxResults: 5,
      },
      webPage: {
        connectTimeout: 10000,
        readTimeout: 30000,
        maxRawBytes: 1048576,
        maxOutputLength: 500000,
        userAgent: 'Mozilla/5.0 (compatible; AgentWorkbench/1.0)',
      },
      shell: {
        maxSessionsPerConversation: 30,
        sessionIdleTimeoutMinutes: 30,
        sessionMaxLifetimeHours: 2,
        output: { maxPreviewLines: 100, maxPreviewChars: 10000 },
      },
    },
    mcp: {
      secretKey: 'mao-mcp-default-secret-change-me',
      clientTimeoutSeconds: 120,
      syncTimeoutSeconds: 60,
    },
  },
  weixin: {
    bot: {
      enabled: false,
      voiceReply: false,
      silkEncoderPath: '/usr/local/bin/silk-encoder',
      ffmpegPath: 'ffmpeg',
      voiceMaxSeconds: 300,
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: '',
      maxInboundFileMb: 100,
      monitor: {
        enabled: true,
        reconcileIntervalMs: 5000,
        longPollTimeoutMs: 35000,
        maxConsecutiveFailures: 3,
      },
    },
  },
  oss: {
    region: '',
    accessKeyId: '',
    accessKeySecret: '',
    bucket: '',
    maxKeys: 1000,
    sts: {
      regionId: '',
      endpoint: '',
      accessKeyId: '',
      accessKeySecret: '',
      roleArn: '',
      roleSessionName: 'mao-sts',
      expire: 3600,
      maxSizeMb: 50,
    },
  },
};

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function findConfigFile(): string | null {
  const extra = process.env.MAO_CONFIG_FILE;
  if (extra && existsSync(extra)) {
    return extra;
  }
  const candidates = [
    join(process.cwd(), 'config/application-local.yml'),
    join(process.cwd(), 'config/application.yml'),
    join(here(), '../../config/application-local.yml'),
    join(here(), '../../config/application.yml'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function keysToCamel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(keysToCamel);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[kebabToCamel(k)] = keysToCamel(v);
    }
    return out;
  }
  return value;
}

function deepMerge<T>(base: T, overlay: unknown): T {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return (overlay as T) ?? base;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof result[k] === 'object' && result[k]) {
      result[k] = deepMerge(result[k], v);
    } else if (v !== undefined) {
      result[k] = v;
    }
  }
  return result as T;
}

function lookupPath(obj: unknown, dotted: string): string | undefined {
  const parts = dotted.split('.').map(kebabToCamel);
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) {
    return undefined;
  }
  return String(cur);
}

function resolvePlaceholders(value: unknown, root: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_m, key: string, def: string | undefined) => {
      if (key === 'HOME' || key === '$HOME') {
        return process.env.HOME ?? def ?? '';
      }
      if (process.env[key] !== undefined) {
        return process.env[key] as string;
      }
      const fromConfig = lookupPath(root, key);
      if (fromConfig !== undefined) {
        return fromConfig;
      }
      return def ?? '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolvePlaceholders(v, root));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolvePlaceholders(v, root);
    }
    return out;
  }
  return value;
}

function coerceTypes(cfg: AppConfig): AppConfig {
  const n = (v: unknown, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  const b = (v: unknown, d: boolean) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return d;
  };
  cfg.server.port = n(process.env.MAO_TS_PORT ?? cfg.server.port, 9080);
  cfg.spring.flyway.enabled = b(process.env.FLYWAY_ENABLED ?? cfg.spring.flyway.enabled, true);
  cfg.ldap.enabled = b(cfg.ldap.enabled, false);
  cfg.feishu.enabled = b(cfg.feishu.enabled, false);
  cfg.jwt.expiration = n(cfg.jwt.expiration, 86400000);
  cfg.jwt.refreshExpiration = n(cfg.jwt.refreshExpiration, 604800000);
  cfg.jwt.shellExpiration = n(cfg.jwt.shellExpiration, 7200000);
  cfg.app.harness.maxConcurrentAgents = n(cfg.app.harness.maxConcurrentAgents, 20);
  cfg.app.harness.agentThreadPoolSize = n(cfg.app.harness.agentThreadPoolSize, 20);
  cfg.app.harness.agentThreadPoolMax = n(cfg.app.harness.agentThreadPoolMax, 100);
  cfg.app.harness.agentThreadPoolQueue = n(cfg.app.harness.agentThreadPoolQueue, 200);
  cfg.app.harness.defaultMaxRounds = n(cfg.app.harness.defaultMaxRounds, 0);
  cfg.app.harness.defaultContextRounds = n(cfg.app.harness.defaultContextRounds, 0);
  return cfg;
}

export function parseJdbcUrl(jdbc: string): { host: string; port: number; database: string } {
  const stripped = jdbc.replace(/^jdbc:mysql:\/\//, '');
  const [hostPort, rest] = stripped.split('/');
  const [host, portStr] = hostPort.split(':');
  const database = (rest ?? '').split('?')[0];
  return {
    host: host || '127.0.0.1',
    port: Number(portStr) || 3306,
    database,
  };
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) {
    return cached;
  }
  let cfg = structuredClone(DEFAULTS);
  const file = findConfigFile();
  if (file) {
    const raw = parseYaml(readFileSync(file, 'utf8'));
    cfg = deepMerge(cfg, keysToCamel(raw));
  }
  cfg = resolvePlaceholders(cfg, cfg) as AppConfig;
  cfg = coerceTypes(cfg);
  if (process.env.JWT_SECRET) {
    cfg.jwt.secret = process.env.JWT_SECRET;
  }
  if (process.env.APP_GIT_CREDENTIAL_SECRET) {
    cfg.app.gitCredential.secretKey = process.env.APP_GIT_CREDENTIAL_SECRET;
  }
  if (process.env.APP_NOTIFICATION_WEBHOOK_SECRET) {
    cfg.app.taskNotification.secretKey = process.env.APP_NOTIFICATION_WEBHOOK_SECRET;
  }
  if (process.env.APP_MCP_SECRET) {
    cfg.app.mcp.secretKey = process.env.APP_MCP_SECRET;
  }
  cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = null;
}

export function configDir(): string {
  return resolve(join(here(), '../../config'));
}
