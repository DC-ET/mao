import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { useTmpDirOutsideRepo } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceGitService } from './workspace-git.service.js';

/**
 * 回归测试：BUG-1 修复（numstatNewPath 还原花括号紧凑形态）的扩大形态验证。
 * git 实测 numstat 对改名的紧凑形态有四种：
 *   1. `old => new`                      无共同前后缀（bugcheck 对照组已覆盖）
 *   2. `prefix/{old => new}`             同目录改名（bugcheck 已覆盖）
 *   3. `{old => new}suffix`              仅共同后缀（目录改名，如 a/x.txt => b/x.txt）
 *   4. `prefix/{old => new}suffix`       前后缀都共同（如 dir/a/same.txt => dir/b/same.txt）
 * 每条用例带夹具自检（断言 git 确实输出该紧凑形态），避免用例失去前提后假通过。
 */
function gitAvailable(): boolean {
  return spawnSync('git', ['--version']).status === 0;
}

function run(cwd: string, ...command: string[]): string {
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Command failed: ${command.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

const describeGit = gitAvailable() ? describe : describe.skip;

describeGit('numstat rename compact forms', () => {
  async function setupRepo() {
    const dir = useTmpDirOutsideRepo('mao-git-shapes-');
    const service = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox-root')));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.email', 'test@example.com');
    run(repo, 'git', 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    run(repo, 'git', 'add', 'README.md');
    run(repo, 'git', 'commit', '-m', 'init');
    return { service, repo };
  }

  async function renameCase(
    name: string,
    oldRel: string,
    newRel: string,
    expectedNumstatFragment: string,
  ): Promise<void> {
    const { service, repo } = await setupRepo();
    const oldAbs = join(repo, oldRel);
    mkdirSync(join(oldAbs, '..'), { recursive: true });
    writeFileSync(oldAbs, 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', `add ${oldRel}`);
    // git mv 要求目标目录已存在
    mkdirSync(join(repo, newRel, '..'), { recursive: true });
    run(repo, 'git', 'mv', oldRel, newRel);
    const newAbs = join(repo, newRel);
    mkdirSync(join(newAbs, '..'), { recursive: true });
    writeFileSync(newAbs, 'a\nB\nc\nd\ne\nf\n');
    run(repo, 'git', 'add', '-A');

    // 夹具自检：git 对该形态确实输出预期紧凑路径（否则用例失去复现前提）
    const numstat = run(repo, 'git', 'diff', '--numstat', 'HEAD');
    expect(numstat, `git numstat for ${oldRel} => ${newRel}`).toContain(expectedNumstatFragment);

    const status = await service.getStatus(repo, null);
    const renamed = status.files!.find((f) => f.path === newRel);
    expect(renamed, `changed file entry for ${newRel}`).toBeDefined();
    expect(renamed!.changeType).toBe('RENAMED');
    expect(renamed!.insertions, `insertions of ${newRel}`).toBe(2);
    expect(renamed!.deletions, `deletions of ${newRel}`).toBe(1);
  }

  it('form 3: common suffix only (directory rename) keeps line stats', async () => {
    await renameCase('suffix-only', 'a/x.txt', 'b/x.txt', '{a => b}/x.txt');
  });

  it('form 4: common prefix and suffix keep line stats', async () => {
    await renameCase('prefix+suffix', 'dir/a/same.txt', 'dir/b/same.txt', 'dir/{a => b}/same.txt');
  });

  it('same directory with different extension keeps line stats', async () => {
    await renameCase('same-dir-ext', 'docs/a.md', 'docs/b.md', 'docs/{a.md => b.md}');
  });

  it('directory containing a space keeps line stats', async () => {
    await renameCase('space-dir', 'my dir/a.txt', 'my dir/b.txt', 'my dir/{a.txt => b.txt}');
  });

  it('deeply nested same-directory rename keeps line stats', async () => {
    await renameCase('deep', 'src/nested/a.txt', 'src/nested/b.txt', 'src/nested/{a.txt => b.txt}');
  });

  it('multiple renames in one changeset each keep their own line stats', async () => {
    const { service, repo } = await setupRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'a\nb\nc\nd\ne\n');
    writeFileSync(join(repo, 'docs', 'a.md'), 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add files');
    run(repo, 'git', 'mv', 'src/a.txt', 'src/b.txt');
    run(repo, 'git', 'mv', 'docs/a.md', 'docs/b.md');
    writeFileSync(join(repo, 'src', 'b.txt'), 'a\nB\nc\nd\ne\nf\n');
    writeFileSync(join(repo, 'docs', 'b.md'), 'a\nB\nc\nd\ne\n');
    run(repo, 'git', 'add', '-A');

    const numstat = run(repo, 'git', 'diff', '--numstat', 'HEAD');
    expect(numstat).toContain('src/{a.txt => b.txt}');
    expect(numstat).toContain('docs/{a.md => b.md}');

    const status = await service.getStatus(repo, null);
    const src = status.files!.find((f) => f.path === 'src/b.txt');
    const docs = status.files!.find((f) => f.path === 'docs/b.md');
    expect(src!.insertions).toBe(2);
    expect(src!.deletions).toBe(1);
    // docs/b.md 只改了 1 行：+1/-1，验证两个改名文件的行数不会互相串味
    expect(docs!.insertions).toBe(1);
    expect(docs!.deletions).toBe(1);
  });
});
