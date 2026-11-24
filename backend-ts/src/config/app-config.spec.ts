import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseJdbcUrl, resetConfigCache } from './app-config.js';

describe('app-config', () => {
  it('parses jdbc url', () => {
    const p = parseJdbcUrl('jdbc:mysql://db.example:3307/mao?useSSL=false');
    expect(p).toEqual({ host: 'db.example', port: 3307, database: 'mao' });
  });

  it('loads defaults and respects MAO_TS_PORT', () => {
    resetConfigCache();
    const prevPort = process.env.MAO_TS_PORT;
    const prevFlyway = process.env.FLYWAY_ENABLED;
    process.env.MAO_TS_PORT = '9080';
    process.env.FLYWAY_ENABLED = 'true';
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(9080);
    expect(cfg.server.servlet.contextPath).toBe('/api');
    expect(cfg.spring.flyway.enabled).toBe(true);
    expect(cfg.jwt.expiration).toBe(86400000);
    if (prevPort === undefined) {
      delete process.env.MAO_TS_PORT;
    } else {
      process.env.MAO_TS_PORT = prevPort;
    }
    if (prevFlyway === undefined) {
      delete process.env.FLYWAY_ENABLED;
    } else {
      process.env.FLYWAY_ENABLED = prevFlyway;
    }
    resetConfigCache();
  });

  it('FLYWAY_ENABLED=false disables schema migrate', () => {
    resetConfigCache();
    const prev = process.env.FLYWAY_ENABLED;
    process.env.FLYWAY_ENABLED = 'false';
    const cfg = loadConfig();
    expect(cfg.spring.flyway.enabled).toBe(false);
    if (prev === undefined) {
      delete process.env.FLYWAY_ENABLED;
    } else {
      process.env.FLYWAY_ENABLED = prev;
    }
    resetConfigCache();
  });
});

describe('cloud runtime config', () => {
  const ENV_KEYS = [
    'MAO_CLOUD_RUNTIME', 'MAO_CONTAINER_IDLE_MINUTES', 'MAO_CONTAINER_IMAGE',
    'MAO_CONTAINER_CHANNEL_DIR', 'MAO_CONTAINER_DIST_DIR',
  ];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  it('defaultsToHostModeWithStandardContainerLimits', () => {
    withEnv({}, () => {
      const cfg = loadConfig();
      expect(cfg.app.cloudRuntime.mode).toBe('host');
      expect(cfg.app.cloudRuntime.container.idleMinutes).toBe(60);
      expect(cfg.app.cloudRuntime.container.maxLifetimeHours).toBe(72);
      expect(cfg.app.cloudRuntime.container.memoryMb).toBe(2048);
      expect(cfg.app.cloudRuntime.container.image).toBe('mao-runtime:latest');
      expect(cfg.app.cloudRuntime.container.network).toBe('bridge');
    });
  });

  it('envOverridesEnableDockerAndPaths', () => {
    withEnv({
      MAO_CLOUD_RUNTIME: 'docker',
      MAO_CONTAINER_IDLE_MINUTES: '30',
      MAO_CONTAINER_IMAGE: 'mao-runtime:v9',
      MAO_CONTAINER_CHANNEL_DIR: '/tmp/chan',
      MAO_CONTAINER_DIST_DIR: '/tmp/dist',
    }, () => {
      const cfg = loadConfig();
      expect(cfg.app.cloudRuntime.mode).toBe('docker');
      expect(cfg.app.cloudRuntime.container.idleMinutes).toBe(30);
      expect(cfg.app.cloudRuntime.container.image).toBe('mao-runtime:v9');
      expect(cfg.app.cloudRuntime.container.channelDir).toBe('/tmp/chan');
      expect(cfg.app.cloudRuntime.container.distDir).toBe('/tmp/dist');
    });
  });
});

describe('入站合并窗口环境变量', () => {
  const ENV_KEYS = [
    'FEISHU_BOT_MERGE_WINDOW_MS',
    'DINGTALK_BOT_MERGE_WINDOW_MS',
    'WEIXIN_BOT_MERGE_WINDOW_MS',
  ];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  it('三端默认均为 1000ms', () => {
    withEnv({}, () => {
      const cfg = loadConfig();
      expect(cfg.feishu.bot.mergeWindowMs).toBe(1000);
      expect(cfg.dingtalk.mergeWindowMs).toBe(1000);
      expect(cfg.weixin.bot.mergeWindowMs).toBe(1000);
    });
  });

  it('WEIXIN_BOT_MERGE_WINDOW_MS 生效：0 即关闭微信合并（文档承诺的回滚开关）', () => {
    // 回归：该变量曾只写进文档没有接线，运维配 0 后微信合并照旧。
    withEnv({ WEIXIN_BOT_MERGE_WINDOW_MS: '0' }, () => {
      const cfg = loadConfig();
      expect(cfg.weixin.bot.mergeWindowMs).toBe(0);
    });
  });

  it('FEISHU/DINGTALK_BOT_MERGE_WINDOW_MS 生效（对照组）', () => {
    withEnv({ FEISHU_BOT_MERGE_WINDOW_MS: '250', DINGTALK_BOT_MERGE_WINDOW_MS: '500' }, () => {
      const cfg = loadConfig();
      expect(cfg.feishu.bot.mergeWindowMs).toBe(250);
      expect(cfg.dingtalk.mergeWindowMs).toBe(500);
    });
  });
});

describe('自定义 HTTP 工具加密密钥环境变量', () => {
  const ENV_KEYS = ['APP_HTTP_TOOL_SECRET', 'APP_USER_TOOL_SECRET'];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  it('旧部署的 APP_USER_TOOL_SECRET 仍然生效（设计 §5.12 要求不改名）', () => {
    withEnv({ APP_USER_TOOL_SECRET: 'legacy-ops-secret' }, () => {
      expect(loadConfig().app.httpTool.secretKey).toBe('legacy-ops-secret');
    });
  });

  it('新名 APP_HTTP_TOOL_SECRET 优先于旧名', () => {
    withEnv({ APP_HTTP_TOOL_SECRET: 'new-secret', APP_USER_TOOL_SECRET: 'legacy-ops-secret' }, () => {
      expect(loadConfig().app.httpTool.secretKey).toBe('new-secret');
    });
  });
});

describe('技能视图根配置（SKILL_VIEWS_DIR）', () => {
  const ENV_KEYS = ['SKILL_VIEWS_DIR'];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  it('未配置时回落 ./skill-views（功能可跑，部署应显式指向 /opt/mao-data/skill-views）', () => {
    withEnv({}, () => {
      expect(loadConfig().app.harness.skillViewsDir).toBe('./skill-views');
    });
  });

  it('SKILL_VIEWS_DIR 覆盖默认值', () => {
    withEnv({ SKILL_VIEWS_DIR: '/opt/mao-data/skill-views' }, () => {
      expect(loadConfig().app.harness.skillViewsDir).toBe('/opt/mao-data/skill-views');
    });
  });
});

describe('发送附件快照根配置（FILE_SEND_DIR，2026-11-24-send-file-snapshot D2）', () => {
  const ENV_KEYS = ['FILE_SEND_DIR', 'FILE_UPLOAD_DIR'];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  // 设计 D2：默认取 {uploadDir 的父目录}/send-files，与 /uploads/ 平级。
  // yml 占位符语法表达不出「另一个值的兄弟目录」，写死 cwd 相对路径会让
  // 「改了 FILE_UPLOAD_DIR 没改它」的部署把快照落到后端 cwd 下（另一块文件系统）。
  it('未配置 FILE_SEND_DIR 时取 FILE_UPLOAD_DIR 的兄弟目录', () => {
    withEnv({ FILE_UPLOAD_DIR: '/opt/mao-data/uploads' }, () => {
      expect(loadConfig().app.file.sendDir).toBe('/opt/mao-data/send-files');
    });
  });

  it('FILE_SEND_DIR 显式设置时以它为准', () => {
    withEnv({ FILE_UPLOAD_DIR: '/opt/mao-data/uploads', FILE_SEND_DIR: '/mnt/disk/snapshots' }, () => {
      expect(loadConfig().app.file.sendDir).toBe('/mnt/disk/snapshots');
    });
  });

  it('两者都缺省时仍是 uploads 的兄弟目录（相对口径）', () => {
    withEnv({}, () => {
      expect(loadConfig().app.file.sendDir).toBe('send-files');
    });
  });

  it('~ 前缀原样保留，交给 create-app 的 expandHome 展开', () => {
    withEnv({ FILE_UPLOAD_DIR: '~/mao/uploads' }, () => {
      expect(loadConfig().app.file.sendDir).toBe('~/mao/send-files');
    });
  });
});

describe('flyway files', () => {
  it('contains the current migration set', () => {
    const tsDir = join(process.cwd(), 'db/migration');
    expect(existsSync(tsDir)).toBe(true);
    const tsFiles = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(tsFiles.some((f) => f.startsWith('V074'))).toBe(true);
  });
});

describe('runtime identity config', () => {
  const ENV_KEYS = ['MAO_RUNTIME_IDENTITY'];

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      resetConfigCache();
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      resetConfigCache();
    }
  }

  it('defaults to execution mode', () => {
    withEnv({}, () => {
      expect(loadConfig().app.harness.runtimeIdentityMode).toBe('execution');
    });
  });

  it('accepts owner / execution and falls back on invalid values', () => {
    withEnv({ MAO_RUNTIME_IDENTITY: 'owner' }, () => {
      expect(loadConfig().app.harness.runtimeIdentityMode).toBe('owner');
    });
    withEnv({ MAO_RUNTIME_IDENTITY: 'execution' }, () => {
      expect(loadConfig().app.harness.runtimeIdentityMode).toBe('execution');
    });
    withEnv({ MAO_RUNTIME_IDENTITY: 'Owner' }, () => {
      expect(loadConfig().app.harness.runtimeIdentityMode).toBe('execution');
    });
  });
});
