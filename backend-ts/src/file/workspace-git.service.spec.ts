import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { EXCLUDED_REPO_DIRS, WorkspaceGitService } from './workspace-git.service.js';

function gitAvailable(): boolean {
  const r = spawnSync('git', ['--version']);
  return r.status === 0;
}

function run(cwd: string, ...command: string[]): string {
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

const describeGit = gitAvailable() ? describe : describe.skip;

describeGit('WorkspaceGitService', () => {
  async function setupRepo() {
    const dir = await mkdtemp(join(tmpdir(), 'mao-git-'));
    const service = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox-root')));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.email', 'test@example.com');
    run(repo, 'git', 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    run(repo, 'git', 'add', 'README.md');
    run(repo, 'git', 'commit', '-m', 'init');
    let branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    if (branch === 'HEAD') {
      run(repo, 'git', 'checkout', '-b', 'main');
      branch = 'main';
    }
    return { dir, service, repo, branch };
  }

  it('cleanRepoReportsZeroChanges', async () => {
    const { service, repo } = await setupRepo();
    const status = await service.getStatus(repo, null);
    expect(status.isGit).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.changedFileCount).toBe(0);
    expect(status.detachedHead).toBe(false);
    expect(status.hasRemote).toBe(false);
    expect(status.hasHead).toBe(true);
    expect(status.remoteStatusAvailable).toBe(false);
    expect(status.aheadCount).toBeNull();
    expect(status.behindCount).toBeNull();
    expect(status.remotes).toEqual([]);
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.files).toEqual([]);
  });

  it('modifiedUntrackedAndDeletedAreListed', async () => {
    const { service, repo } = await setupRepo();
    writeFileSync(join(repo, 'README.md'), 'hello\nworld\n');
    writeFileSync(join(repo, 'new.txt'), 'line1\nline2\n');
    writeFileSync(join(repo, 'gone.txt'), 'x\n');
    run(repo, 'git', 'add', 'gone.txt');
    run(repo, 'git', 'commit', '-m', 'add gone');
    unlinkSync(join(repo, 'gone.txt'));

    const status = await service.getStatus(repo, null);
    expect(status.isGit).toBe(true);
    expect(status.changedFileCount).toBe(3);
    expect(status.files?.map((f) => f.path)).toEqual(expect.arrayContaining(['README.md', 'new.txt', 'gone.txt']));

    const readme = status.files!.find((f) => f.path === 'README.md')!;
    expect(readme.changeType).toBe('MODIFIED');
    expect(readme.insertions).toBeGreaterThan(0);

    const created = status.files!.find((f) => f.path === 'new.txt')!;
    expect(created.changeType).toBe('CREATED');
    expect(created.untracked).toBe(true);
    expect(created.insertions).toBe(2);

    const deleted = status.files!.find((f) => f.path === 'gone.txt')!;
    expect(deleted.changeType).toBe('DELETED');

    const diff = await service.getFileDiff(repo, null, 'README.md');
    expect(diff.beforeContent).toContain('hello');
    expect(diff.afterContent).toContain('world');
    expect(diff.changeType).toBe('MODIFIED');

    const newDiff = await service.getFileDiff(repo, null, 'new.txt');
    expect(newDiff.beforeContent).toBe('');
    expect(newDiff.afterContent).toContain('line1');
  });

  it('statusUsesLocalUpstreamRefsWithoutFetching', async () => {
    const { dir, service, repo } = await setupRepo();
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    const branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);
    writeFileSync(join(repo, 'local.txt'), 'local\n');
    run(repo, 'git', 'add', 'local.txt');
    run(repo, 'git', 'commit', '-m', 'local');

    const status = await service.getStatus(repo, null);
    expect(status.upstream).toBe(`origin/${branch}`);
    expect(status.aheadCount).toBe(1);
    expect(status.behindCount).toBe(0);
    expect(status.remoteStatusAvailable).toBe(false);
    expect(status.remoteStatusError ?? null).toBeNull();
  });

  it('unbornRepositoryReportsNoHead', async () => {
    const { dir, service } = await setupRepo();
    const unborn = join(dir, 'unborn');
    mkdirSync(unborn, { recursive: true });
    run(unborn, 'git', 'init');
    const status = await service.getStatus(unborn, null);
    expect(status.isGit).toBe(true);
    expect(status.hasHead).toBe(false);
    expect(status.aheadCount).toBeNull();
    expect(status.behindCount).toBeNull();
  });

  it('repoDiscoveryExcludesToolDirectories', async () => {
    const { dir, service } = await setupRepo();
    const workspace = join(dir, 'multi');
    mkdirSync(workspace, { recursive: true });
    for (const name of EXCLUDED_REPO_DIRS) {
      const nested = join(workspace, name);
      mkdirSync(nested, { recursive: true });
      run(nested, 'git', 'init');
    }
    const project = join(workspace, 'business-project');
    mkdirSync(project, { recursive: true });
    run(project, 'git', 'init');

    const result = await service.listRepos(workspace);
    expect(result.isRootGit).toBe(false);
    expect(result.repos.map((r) => r.name)).toEqual(['business-project']);
  });

  it('nonGitDirectoryReturnsIsGitFalse', async () => {
    const { dir, service } = await setupRepo();
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'a.txt'), 'a');
    const status = await service.getStatus(plain, null);
    expect(status.isGit).toBe(false);
  });
});
