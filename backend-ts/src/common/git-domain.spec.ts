import { describe, expect, it } from 'vitest';
import { BusinessException } from './business-exception.js';
import { assertGitDomainValid, normalizeAndValidateGitDomain, normalizeGitDomain } from './git-domain.js';

describe('normalizeGitDomain', () => {
  it('规范化：去协议头 / 去路径 / 小写 / trim', () => {
    expect(normalizeGitDomain('https://GitHub.com/foo')).toBe('github.com');
    expect(normalizeGitDomain('http://git.acg.team/group/repo.git')).toBe('git.acg.team');
    expect(normalizeGitDomain('  GIT.ACG.TEAM  ')).toBe('git.acg.team');
    expect(normalizeGitDomain('git.zizaitianye.com')).toBe('git.zizaitianye.com');
  });

  it('空值抛「域名不能为空」（保留原始文案）', () => {
    expect(() => normalizeGitDomain('')).toThrow(/域名不能为空/);
    expect(() => normalizeGitDomain('   ')).toThrow(BusinessException);
    expect(() => normalizeGitDomain(null)).toThrow(/域名不能为空/);
    expect(() => normalizeGitDomain(undefined)).toThrow(/域名不能为空/);
  });
});

describe('assertGitDomainValid', () => {
  it('合法域名通过', () => {
    expect(() => assertGitDomainValid('github.com')).not.toThrow();
    expect(() => assertGitDomainValid('git.acg.team')).not.toThrow();
    expect(() => assertGitDomainValid('a-b.c-d.example.com')).not.toThrow();
  });

  it('非法域名抛「域名格式无效」（保留原始文案，与空值文案分离）', () => {
    expect(() => assertGitDomainValid('not a domain')).toThrow(/域名格式无效/);
    expect(() => assertGitDomainValid('-bad.com')).toThrow(/域名格式无效/);
    expect(() => assertGitDomainValid('bad-.com')).toThrow(/域名格式无效/);
    expect(() => assertGitDomainValid('a..b')).toThrow(/域名格式无效/);
  });
});

describe('normalizeAndValidateGitDomain', () => {
  it('组合：规范化后校验', () => {
    expect(normalizeAndValidateGitDomain('https://GitHub.com/foo')).toBe('github.com');
    expect(() => normalizeAndValidateGitDomain('https://bad domain/x')).toThrow(/域名格式无效/);
  });
});
