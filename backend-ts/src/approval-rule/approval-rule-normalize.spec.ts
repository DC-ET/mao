import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RULE_DENY_TOKENS_SEED,
  buildApprovalHint,
  buildShellPrefixValue,
  buildShellRuleCandidates,
  containsDenyToken,
  matchesShellPrefix,
  normalizeShellCommand,
  tokenizeCommand,
} from './approval-rule-normalize.js';

describe('tokenizeCommand', () => {
  it('splitsOnWhitespaceAndStructuralPunctuation', () => {
    expect(tokenizeCommand('npm run build && rm x')).toEqual(['npm', 'run', 'build', 'rm', 'x']);
    expect(tokenizeCommand('cat a | grep b; echo c > d')).toEqual(['cat', 'a', 'grep', 'b', 'echo', 'c', 'd']);
  });

  it('keepsDashSlashSlashEqualsInsideTokens', () => {
    // 连字符、斜杠、等号不切分：rm-cache / docs/su/ / --force-with-lease 保持完整 token 不误伤
    expect(tokenizeCommand('cat docs/rm-cache/x')).toEqual(['cat', 'docs/rm-cache/x']);
    expect(tokenizeCommand('git push --force-with-lease')).toEqual(['git', 'push', '--force-with-lease']);
    expect(tokenizeCommand('FOO=bar echo hi')).toEqual(['FOO=bar', 'echo', 'hi']);
  });
});

describe('normalizeShellCommand', () => {
  it('stripsLeadingEnvAssignments', () => {
    expect(normalizeShellCommand('FOO=bar npm run build')).toBe('npm run build');
    expect(normalizeShellCommand('FOO=bar BAZ=qux npm run build')).toBe('npm run build');
    // 等号出现在非首段不属于 env 前缀
    expect(normalizeShellCommand('echo a=b')).toBe('echo a=b');
  });

  it('collapsesWhitespaceAndTrims', () => {
    expect(normalizeShellCommand('   npm   run \t build  ')).toBe('npm run build');
  });

  it('truncatesTo512', () => {
    expect(normalizeShellCommand('x'.repeat(600)).length).toBe(512);
  });

  it('returnsEmptyForEnvOnlyCommand', () => {
    expect(normalizeShellCommand('FOO=bar')).toBe('');
  });
});

describe('buildShellPrefixValue', () => {
  it('takesFirstTwoTokens', () => {
    expect(buildShellPrefixValue('npm run build')).toBe('npm run');
    expect(buildShellPrefixValue('git push origin main')).toBe('git push');
  });

  it('takesSingleTokenCommandAsIs', () => {
    expect(buildShellPrefixValue('ls')).toBe('ls');
  });
});

describe('matchesShellPrefix', () => {
  it('matchesAtWordBoundary', () => {
    expect(matchesShellPrefix('npm run build', 'npm run')).toBe(true);
    expect(matchesShellPrefix('npm run', 'npm run')).toBe(true);
    // 词边界：npm run 不放行 npm runx
    expect(matchesShellPrefix('npm runx', 'npm run')).toBe(false);
    expect(matchesShellPrefix('npmx run', 'npm run')).toBe(false);
    expect(matchesShellPrefix('npm', 'npm run')).toBe(false);
  });
});

describe('containsDenyToken', () => {
  it('rejectsCommandsContainingSeedTokens', () => {
    expect(containsDenyToken('rm -rf x', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
    expect(containsDenyToken('npm run build && rm x', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
    expect(containsDenyToken('sudo ls', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
    expect(containsDenyToken('git push --force origin main', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
  });

  it('doesNotMisfireOnSubstrings', () => {
    expect(containsDenyToken('cat docs/rm-cache/x', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(false);
    expect(containsDenyToken('git push --force-with-lease', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(false);
    expect(containsDenyToken('npm run build', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(false);
  });
});

describe('buildShellRuleCandidates', () => {
  it('buildsExactThenPrefixFromCommandArgs', () => {
    const candidates = buildShellRuleCandidates('{"command":"FOO=1 npm  run build"}');
    expect(candidates).toEqual([
      { ruleType: 'SHELL_EXACT', ruleValue: 'npm run build' },
      { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' },
    ]);
  });

  it('returnsEmptyForMissingOrInvalidCommand', () => {
    expect(buildShellRuleCandidates('{}')).toEqual([]);
    expect(buildShellRuleCandidates('not-json')).toEqual([]);
    expect(buildShellRuleCandidates('{"command":"   "}')).toEqual([]);
  });
});

describe('buildApprovalHint', () => {
  it('buildsPrefixHintForShell', () => {
    const hint = buildApprovalHint('shell', '{"command":"npm test"}', []);
    expect(hint).toEqual({
      ruleType: 'SHELL_PREFIX',
      ruleValue: 'npm test',
      label: '本会话总是允许以 npm test 开头的命令',
    });
  });

  it('stripsEnvPrefixInHintValue', () => {
    const hint = buildApprovalHint('shell', '{"command":"FOO=bar npm run build"}', []);
    expect(hint?.ruleValue).toBe('npm run');
  });

  it('returnsNullWhenCommandContainsDenyToken', () => {
    expect(buildApprovalHint('shell', '{"command":"rm x"}', APPROVAL_RULE_DENY_TOKENS_SEED)).toBeNull();
    expect(buildApprovalHint('shell', '{"command":"git push --force"}', APPROVAL_RULE_DENY_TOKENS_SEED)).toBeNull();
    // 管道后半段也在扫描范围内
    expect(buildApprovalHint('shell', '{"command":"npm run build && rm x"}', APPROVAL_RULE_DENY_TOKENS_SEED)).toBeNull();
  });

  it('buildsToolHintForMcpTool', () => {
    const hint = buildApprovalHint('mcp__filesystem__read_file', '{}', []);
    expect(hint).toEqual({
      ruleType: 'MCP_TOOL',
      ruleValue: 'mcp__filesystem__read_file',
      label: '本会话总是允许调用 mcp__filesystem__read_file',
    });
  });

  it('returnsNullForNonRuleableTools', () => {
    expect(buildApprovalHint('write_file', '{"path":"x"}', [])).toBeNull();
    expect(buildApprovalHint('read_file', '{}', [])).toBeNull();
  });
});
