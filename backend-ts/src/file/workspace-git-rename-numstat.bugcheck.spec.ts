import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { useTmpDirOutsideRepo } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceGitService } from './workspace-git.service.js';

/**
 * BUGCHECK（审查新增，非产品代码）：同目录（同前缀目录）改名时 git numstat 输出
 * 花括号紧凑形态 `src/{a.txt => b.txt}`，workspace-git.service.ts:388-393 只做
 * `lastIndexOf(' => ') + 4` 切片，残留尾部 `}`，与 name-status 的键 `src/b.txt`
 * 匹配不上，insertions/deletions 被静默丢弃（保持 0）。
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
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

describeGit('BUGCHECK same-directory rename numstat', () => {
  async function setupRepo() {
    const dir = useTmpDirOutsideRepo('mao-git-rename-');
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

  it('keeps insertions and deletions for a brace-form rename', async () => {
    const { service, repo } = await setupRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add src');
    run(repo, 'git', 'mv', 'src/a.txt', 'src/b.txt');
    writeFileSync(join(repo, 'src', 'b.txt'), 'a\nB\nc\nd\ne\nf\n');
    run(repo, 'git', 'add', '-A');

    // 夹具自检：git 对该形态确实输出花括号紧凑路径（否则用例失去复现前提）
    const numstat = run(repo, 'git', 'diff', '--numstat', 'HEAD');
    expect(numstat).toContain('src/{a.txt => b.txt}');

    const status = await service.getStatus(repo, null);
    const renamed = status.files!.find((f) => f.path === 'src/b.txt');
    expect(renamed).toBeDefined();
    expect(renamed!.changeType).toBe('RENAMED');
    expect(renamed!.insertions).toBe(2);
    expect(renamed!.deletions).toBe(1);
  });

  it('cross-directory rename keeps its line stats (control group)', async () => {
    const { service, repo } = await setupRepo();
    mkdirSync(join(repo, 'old'), { recursive: true });
    mkdirSync(join(repo, 'new'), { recursive: true });
    writeFileSync(join(repo, 'old', 'a.txt'), 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add old');
    run(repo, 'git', 'mv', 'old/a.txt', 'new/b.txt');
    writeFileSync(join(repo, 'new', 'b.txt'), 'a\nB\nc\nd\ne\nf\n');
    run(repo, 'git', 'add', '-A');

    const numstat = run(repo, 'git', 'diff', '--numstat', 'HEAD');
    expect(numstat).not.toContain('{');

    const status = await service.getStatus(repo, null);
    const renamed = status.files!.find((f) => f.path === 'new/b.txt');
    expect(renamed).toBeDefined();
    expect(renamed!.changeType).toBe('RENAMED');
    expect(renamed!.insertions).toBe(2);
    expect(renamed!.deletions).toBe(1);
  });
});
