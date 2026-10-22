/**
 * 2026-10-22 代码审查 BUG 验证用例（配置装载 / 路径解析）。
 *
 * 用例断言「应有行为」，当前代码不满足 → 用例失败即证明 BUG 真实存在。
 *
 * BUG-C1：resolvePlaceholders 用 `process.env[key] !== undefined` 判定环境变量是否存在，
 *        空串（`KEY=`）也算「已设置」→ `${VAR:default}` 的默认值被空串顶掉，
 *        skills-dir / workspace-root 变成空路径。
 *
 * BUG-C2：coerceTypes 的 n() 用 `Number.isFinite(Number(v))` 判定，Number('') === 0 且有限，
 *        于是 `MAO_TS_PORT=`（空）得到 0 而不是默认值 9080。端口 0 = 随机端口，
 *        服务起来但 nginx / 健康检查永远连不上。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from './app-config.js';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
}

describe('BUG-C1 空串环境变量顶掉 ${VAR:default} 的默认值', () => {
  it('SKILLS_DIR= 空串时不应把 skills-dir 解析成空路径', () => {
    withEnv({ SKILLS_DIR: '' }, () => {
      const cfg = loadConfig();
      expect(cfg.app.harness.skillsDir).not.toBe('');
      expect(cfg.app.harness.skillsDir).toBe('./skills');
    });
  });

  it('WORKSPACE_ROOT= 空串时不应把 workspace-root 解析成空路径', () => {
    withEnv({ WORKSPACE_ROOT: '' }, () => {
      const cfg = loadConfig();
      expect(cfg.app.harness.workspaceRoot).not.toBe('');
      expect(cfg.app.harness.workspaceRoot).toBe('./workspace');
    });
  });
});

describe('BUG-C2 数字型环境变量为空串时被解析成 0 而不是默认值', () => {
  it('MAO_TS_PORT= 空串时端口应为默认 9080，而不是 0（随机端口）', () => {
    withEnv({ MAO_TS_PORT: '' }, () => {
      const cfg = loadConfig();
      expect(cfg.server.port).toBe(9080);
    });
  });

  it('MAO_CLEANUP_INTERVAL_MS= 空串时应保留默认间隔，而不是 0', () => {
    withEnv({ MAO_CLEANUP_INTERVAL_MS: '' }, () => {
      const cfg = loadConfig();
      expect(cfg.app.harness.cleanup.intervalMs).toBe(24 * 3600 * 1000);
    });
  });
});
