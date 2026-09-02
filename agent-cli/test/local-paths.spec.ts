import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectShell, findBash, requireBash } from '../src/local/paths';
import { readAgentsMd } from '../src/local/local-skills';

let savedPath: string | undefined;
let ws: string;

beforeEach(() => {
  savedPath = process.env.PATH;
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-paths-')));
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('bash resolution', () => {
  it('finds an executable bash and reports the same path through detectShell', () => {
    const bash = findBash();
    expect(bash).not.toBeNull();
    expect(path.isAbsolute(bash!)).toBe(true);
    expect(fs.existsSync(bash!)).toBe(true);
    expect(detectShell()).toBe(bash);
    expect(requireBash()).toBe(bash);
  });

  it('falls back to well-known directories when PATH is empty', () => {
    process.env.PATH = '';
    expect(findBash()).not.toBeNull();
  });

  it('prefers a bash found on PATH over the fallback directories', () => {
    const fake = path.join(ws, 'bash');
    fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = ws;
    expect(findBash()).toBe(fake);
  });

  it('ignores non-executable candidates on PATH', () => {
    fs.writeFileSync(path.join(ws, 'bash'), '#!/bin/sh\n', { mode: 0o644 });
    process.env.PATH = ws;
    // 只有可执行的候选才算命中，这里应回落到系统 bash。
    expect(findBash()).not.toBe(path.join(ws, 'bash'));
  });
});

describe('readAgentsMd', () => {
  it('returns undefined when there is no workspace or no file', () => {
    expect(readAgentsMd(undefined)).toBeUndefined();
    expect(readAgentsMd(ws)).toBeUndefined();
  });

  it('returns the file content as-is below the limit', () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# rules\n');
    expect(readAgentsMd(ws)).toBe('# rules\n');
  });

  it('truncates oversized AGENTS.md instead of injecting it whole', () => {
    const limit = 100 * 1024;
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'a'.repeat(limit + 5000));
    const content = readAgentsMd(ws)!;
    expect(content.endsWith('\n…[AGENTS.md 已截断]')).toBe(true);
    expect(content.length).toBe(limit + '\n…[AGENTS.md 已截断]'.length);
  });

  it('ignores a directory named AGENTS.md', () => {
    fs.mkdirSync(path.join(ws, 'AGENTS.md'));
    expect(readAgentsMd(ws)).toBeUndefined();
  });
});
