import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 容器内代码的依赖约束（技术方案 §5.5 关键约束 / §7 安全回归）：
 * runtime agent 及其加载的容器内模块不得 import 任何触及 MySQL / JWT secret /
 * LLM key 的模块。静态扫描源码 import 列表守住。
 */
const CONTAINER_MODULES = [
  'runtime-agent.ts',
  'container-tool-executor.ts',
  'container-mcp-bridge.ts',
  'pty-hub.ts',
  'runtime-channel-protocol.ts',
];

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /db\/db\.js|createPool|Mysql.*Repository/i, why: 'MySQL 访问' },
  { pattern: /jwt\.service|JwtService/i, why: 'JWT secret' },
  { pattern: /llm-adapter|LlmAdapterFacade|danger-assessor|openai-llm|anthropic-llm|responses-llm/i, why: 'LLM 调用' },
  { pattern: /app-config(?!\.spec)/, why: 'app-config 会带入全部平台配置' },
  { pattern: /git-credential\.service/i, why: '平台级 git 凭据服务（容器内凭据走 envelope）' },
];

describe('container runtime module import constraints', () => {
  const containerDir = resolve(dirname(fileURLToPath(import.meta.url)));

  it('containerModulesDoNotImportPlatformSecretModules', () => {
    for (const file of CONTAINER_MODULES) {
      const path = join(containerDir, file);
      expect(existsSync(path), file).toBe(true);
      const source = readFileSync(path, 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const imported of imports) {
        for (const { pattern, why } of FORBIDDEN_PATTERNS) {
          expect({
            file,
            imported,
            fail: pattern.test(imported),
          }, `${file} imports ${imported} (${why})`).toEqual(expect.objectContaining({ fail: false }));
        }
      }
    }
  });
});
