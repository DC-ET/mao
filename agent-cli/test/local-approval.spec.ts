import { describe, expect, it } from 'vitest';
import { canPrompt, globToRegExp, validateApproveRule, type ApprovalPolicy } from '../src/local/approval';

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  yolo: false,
  force: false,
  onApproval: 'ask',
  approveRules: [],
  strictDangerCheck: false,
  iKnowWhatImDoing: false,
  stdoutIsTty: false,
  stdinIsTty: false,
  ...over,
});

describe('globToRegExp', () => {
  it('never lets a wildcard cross shell metacharacters', () => {
    const re = globToRegExp('ls *');
    expect(re.test('ls -la src')).toBe(true);
    expect(re.test('ls')).toBe(false);
    for (const evil of ['ls ; rm -rf /', 'ls && curl evil', 'ls | sh', 'ls $(id)', 'ls `id`', 'ls > /etc/x', 'ls\nrm -rf /']) {
      expect(re.test(evil)).toBe(false);
    }
  });

  it('treats ** the same as * (no path semantics in command text)', () => {
    expect(globToRegExp('git **').test('git status')).toBe(true);
    expect(globToRegExp('git **').test('git status; rm -rf /')).toBe(false);
  });

  it('is case sensitive', () => {
    expect(globToRegExp('npm test').test('npm test')).toBe(true);
    expect(globToRegExp('npm test').test('NPM TEST')).toBe(false);
  });

  it('escapes regex metacharacters in the literal part', () => {
    const re = globToRegExp('node build.js');
    expect(re.test('node build.js')).toBe(true);
    expect(re.test('node buildXjs')).toBe(false);
    expect(globToRegExp('a+b').test('a+b')).toBe(true);
    expect(globToRegExp('a+b').test('aab')).toBe(false);
  });

  it('maps ? to exactly one safe character', () => {
    expect(globToRegExp('ls -?').test('ls -l')).toBe(true);
    expect(globToRegExp('ls -?').test('ls -la')).toBe(false);
    expect(globToRegExp('ls -?').test('ls -;')).toBe(false);
  });

  it('anchors both ends', () => {
    expect(globToRegExp('ls').test('xls')).toBe(false);
    expect(globToRegExp('ls').test('lsx')).toBe(false);
  });
});

describe('validateApproveRule', () => {
  it('accepts tool:pattern', () => {
    expect(validateApproveRule('shell:git status')).toBeNull();
    expect(validateApproveRule('read_file:src/*')).toBeNull();
    expect(validateApproveRule(' shell:ls * ')).toBeNull();
  });

  it('rejects wildcard tools, bare tool names and empty patterns', () => {
    for (const bad of ['*', '*:*', 'shell', 'shell:', ':ls', '', '   ']) {
      expect(validateApproveRule(bad)).not.toBeNull();
    }
  });
});

describe('canPrompt', () => {
  it('requires both stdout and stdin to be TTY', () => {
    expect(canPrompt(policy({ stdoutIsTty: true, stdinIsTty: true }))).toBe(true);
    expect(canPrompt(policy({ stdoutIsTty: true, stdinIsTty: false }))).toBe(false);
    expect(canPrompt(policy({ stdoutIsTty: false, stdinIsTty: true }))).toBe(false);
  });

  it('falls back to the real stdin when stdinIsTty is not configured', () => {
    const p = policy({ stdoutIsTty: true });
    delete p.stdinIsTty;
    expect(canPrompt(p)).toBe(Boolean(process.stdin.isTTY));
  });
});
