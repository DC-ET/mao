import { describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';

/**
 * 逻辑回归用例（round2 审查修复后转正）：
 * parseCliConfig 对未显式下发的 permissionLevel / outputFormat 也填入默认值，
 * 导致 resolveConfig 的 `cli.x || project.x || user.x` 优先级链永远命中 CLI 默认，
 * 用户/项目配置文件里的这两项永久失效（--help 声明的优先级被破坏）。
 */

const tty = { stdoutIsTty: true, stdinIsTty: true };

describe('未下发的枚举参数必须留空以让配置文件生效', () => {
  it('不传 --permission-level 时 parseCliConfig 不应塞入 READ_WRITE 默认值', () => {
    const cfg = parseCliConfig([], tty);
    expect(cfg.permissionLevel).toBeUndefined();
  });

  it('不传 --output-format 时 parseCliConfig 不应塞入 text 默认值', () => {
    const cfg = parseCliConfig([], tty);
    expect(cfg.outputFormat).toBeUndefined();
  });

  it('显式下发时仍按枚举解析（大小写归一）', () => {
    expect(parseCliConfig(['--permission-level', 'full'], tty).permissionLevel).toBe('FULL');
    expect(parseCliConfig(['--output-format', 'JSON'], tty).outputFormat).toBe('json');
  });

  it('环境变量仍应生效（不依赖配置文件）', () => {
    const prev = process.env.MAO_AGENT_OUTPUT_FORMAT;
    process.env.MAO_AGENT_OUTPUT_FORMAT = 'stream-json';
    try {
      expect(parseCliConfig([], tty).outputFormat).toBe('stream-json');
    } finally {
      if (prev === undefined) delete process.env.MAO_AGENT_OUTPUT_FORMAT;
      else process.env.MAO_AGENT_OUTPUT_FORMAT = prev;
    }
  });
});
