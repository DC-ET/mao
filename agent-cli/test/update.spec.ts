import { describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';
import { compareVersions } from '../src/commands/update';

const tty = { stdoutIsTty: true, stdinIsTty: true };

describe('update command args', () => {
  it('parses update as a command', () => {
    const cfg = parseCliConfig(['update'], tty);
    expect(cfg.command).toBe('update');
  });

  it('parses update flags', () => {
    const cfg = parseCliConfig(
      ['update', '--check', '--ref', 'v0.0.40', '--repo', 'https://example.com/mao.git', '--src-dir', '/tmp/src'],
      tty,
    );
    expect(cfg.updateCheck).toBe(true);
    expect(cfg.updateRef).toBe('v0.0.40');
    expect(cfg.updateRepo).toBe('https://example.com/mao.git');
    expect(cfg.updateSrcDir).toBe('/tmp/src');
  });

  it('defaults update flags', () => {
    const cfg = parseCliConfig(['update'], tty);
    expect(cfg.updateCheck).toBe(false);
    expect(cfg.updateRef).toBeUndefined();
    expect(cfg.updateRepo).toBeUndefined();
    expect(cfg.updateSrcDir).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders dotted versions', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.0.40', '0.0.40')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('1', '0.9')).toBe(1);
  });
});
