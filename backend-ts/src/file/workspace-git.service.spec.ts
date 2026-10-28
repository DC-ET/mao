import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { useTmpDirOutsideRepo } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { BusinessException } from '../common/business-exception.js';
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
    // 夹具必须在仓库外：这些用例断言「目录不是 git 仓库」，落仓库内会向上发现 .git
    const dir = useTmpDirOutsideRepo('mao-git-');
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

  // ===== Git 管理器中央 Tab：只读扩展 =====

  it('getLogReturnsParsedEntriesWithRefs', async () => {
    const { service, repo, branch } = await setupRepo();
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    run(repo, 'git', 'add', 'a.txt');
    run(repo, 'git', 'commit', '-m', 'second commit');
    run(repo, 'git', 'tag', 'v1.0');

    const entries = await service.getLog(repo, null, { limit: 10 });
    expect(entries.length).toBe(2);
    const latest = entries[0];
    expect(latest.title).toBe('second commit');
    expect(latest.author).toBe('Test');
    expect(latest.shortHash).toHaveLength(7);
    expect(latest.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(latest.refs).toContain(`HEAD -> ${branch}`);
    expect(latest.refs).toContain('tag: v1.0');
  });

  it('getLogClampsLimitAndHonorsOffset', async () => {
    const { service, repo } = await setupRepo();
    for (const name of ['b.txt', 'c.txt', 'd.txt']) {
      writeFileSync(join(repo, name), `${name}\n`);
      run(repo, 'git', 'add', name);
      run(repo, 'git', 'commit', '-m', `add ${name}`);
    }
    const limited = await service.getLog(repo, null, { limit: 2 });
    expect(limited.map((e) => e.title)).toEqual(['add d.txt', 'add c.txt']);
    const skipped = await service.getLog(repo, null, { limit: 2, offset: 1 });
    expect(skipped.map((e) => e.title)).toEqual(['add c.txt', 'add b.txt']);
    // limit 越界钳制到 [1,200] 下界：0 → 1
    const zeroLimit = await service.getLog(repo, null, { limit: 0 });
    expect(zeroLimit.length).toBe(1);
  });

  it('getLogOnUnbornRepositoryReturnsEmpty', async () => {
    const { dir, service } = await setupRepo();
    const unborn = join(dir, 'unborn');
    mkdirSync(unborn, { recursive: true });
    run(unborn, 'git', 'init');
    expect(await service.getLog(unborn, null, {})).toEqual([]);
  });

  it('getCommitFilesRejectsUnknownHash', async () => {
    const { service, repo } = await setupRepo();
    // 格式合法但 git 中不存在：必须报错，不能返空列表（空列表与空提交无法区分）
    await expect(service.getCommitFiles(repo, null, 'abc1234')).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getCommitFiles(repo, null, 'not-a-hash')).rejects.toBeInstanceOf(BusinessException);
  });

  it('getCommitFilesMergesNumstatForSameDirectoryRename', async () => {
    const { service, repo } = await setupRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add src');
    run(repo, 'git', 'mv', 'src/a.txt', 'src/b.txt');
    writeFileSync(join(repo, 'src', 'b.txt'), 'a\nB\nc\nd\ne\nf\n');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'rename a to b');

    const hash = run(repo, 'git', 'rev-parse', 'HEAD').trim();
    const result = await service.getCommitFiles(repo, null, hash);
    expect(result.hash).toBe(hash);
    expect(result.files.length).toBe(1);
    const file = result.files[0];
    expect(file.changeType).toBe('RENAMED');
    expect(file.path).toBe('src/b.txt');
    // numstat（花括号紧凑形态）必须与 name-status 按键合并：漏合并则改名恒显 +0/-0
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it('getCommitFileDiffCoversModifiedCreatedAndDeleted', async () => {
    const { service, repo } = await setupRepo();
    writeFileSync(join(repo, 'mod.txt'), 'before\n');
    writeFileSync(join(repo, 'del.txt'), 'delete me\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'seed');
    writeFileSync(join(repo, 'mod.txt'), 'after\n');
    writeFileSync(join(repo, 'add.txt'), 'brand new\n');
    run(repo, 'git', 'rm', '-q', 'del.txt');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'change');
    const hash = run(repo, 'git', 'rev-parse', 'HEAD').trim();

    const modified = await service.getCommitFileDiff(repo, null, hash, 'mod.txt');
    expect(modified.changeType).toBe('MODIFIED');
    expect(modified.beforeContent).toContain('before');
    expect(modified.afterContent).toContain('after');

    const created = await service.getCommitFileDiff(repo, null, hash, 'add.txt');
    expect(created.changeType).toBe('CREATED');
    expect(created.beforeContent).toBe('');
    expect(created.afterContent).toContain('brand new');

    const deleted = await service.getCommitFileDiff(repo, null, hash, 'del.txt');
    expect(deleted.changeType).toBe('DELETED');
    expect(deleted.afterContent).toBe('');
    expect(deleted.beforeContent).toContain('delete me');
  });

  it('getCommitFileDiffReadsRenamedFileFromItsOldPath', async () => {
    const { service, repo } = await setupRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'old content\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add src/a.txt');
    run(repo, 'git', 'mv', 'src/a.txt', 'src/b.txt');
    writeFileSync(join(repo, 'src', 'b.txt'), 'new content\n');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'rename and edit');
    const hash = run(repo, 'git', 'rev-parse', 'HEAD').trim();

    // 不传 oldPath：新路径在父提交不存在，before 取空、退化成 CREATED（旧缺陷）
    const naive = await service.getCommitFileDiff(repo, null, hash, 'src/b.txt');
    expect(naive.changeType).toBe('CREATED');

    // 传 oldPath（文件清单 R 行的旧路径）：before 取自父提交的旧路径，changeType 对齐「改名」
    const renamed = await service.getCommitFileDiff(repo, null, hash, 'src/b.txt', 'src/a.txt');
    expect(renamed.changeType).toBe('RENAMED');
    expect(renamed.beforeContent).toContain('old content');
    expect(renamed.afterContent).toContain('new content');
  });

  it('readMethodsRejectWorkspacesNestedInsideAnOuterRepository', async () => {
    // 夹具必须在仓库外：外层仓库本身也要落在 tmp 目录里
    const dir = useTmpDirOutsideRepo('mao-git-nested-');
    const service = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox-root')));
    const outer = join(dir, 'outer');
    mkdirSync(outer, { recursive: true });
    run(outer, 'git', 'init');
    run(outer, 'git', 'config', 'user.email', 'test@example.com');
    run(outer, 'git', 'config', 'user.name', 'Test');
    writeFileSync(join(outer, 'outside-secret.txt'), 'outer repo file outside workspace\n');
    run(outer, 'git', 'add', '.');
    run(outer, 'git', 'commit', '-m', 'outer init');
    const hash = run(outer, 'git', 'rev-parse', 'HEAD').trim();
    const ws = join(outer, 'ws');
    mkdirSync(ws, { recursive: true });

    // 工作区本身位于外层 git 仓库内部：rev-parse --show-toplevel 会跳出工作区，
    // 只读方法必须拒绝（与写路径 resolveRepository 同口径），否则读到外层仓库元数据
    await expect(service.getLog(ws, null, {})).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getBranches(ws, null)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getStashes(ws, null)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getRemotes(ws, null)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getCommitFiles(ws, null, hash)).rejects.toBeInstanceOf(BusinessException);
    // 最关键：不能读到工作区之外的受控文件内容
    await expect(service.getCommitFileDiff(ws, null, hash, 'outside-secret.txt')).rejects.toBeInstanceOf(BusinessException);
  });

  it('getBranchesParsesLocalRemoteAndAheadBehind', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);
    run(repo, 'git', 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'f.txt'), 'f\n');
    run(repo, 'git', 'add', 'f.txt');
    run(repo, 'git', 'commit', '-m', 'feature work');

    const branches = await service.getBranches(repo, null);
    const current = branches.find((b) => b.name === 'feature' && !b.isRemote);
    expect(current).toBeDefined();
    expect(current!.isCurrent).toBe(true);
    expect(current!.upstream).toBeNull();
    expect(current!.lastCommitHash).toMatch(/^[0-9a-f]{7,64}$/);
    expect(current!.lastCommitTitle).toBe('feature work');

    const remoteMain = branches.find((b) => b.name === `origin/${branch}`)
      ?? branches.find((b) => b.isRemote && b.name.endsWith(branch));
    expect(remoteMain).toBeDefined();
    expect(remoteMain!.isRemote).toBe(true);
    expect(remoteMain!.isCurrent).toBe(false);
    expect(remoteMain!.upstream).toBeNull();
  });

  it('getBranchesReportsAheadBehindAgainstUpstream', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);
    writeFileSync(join(repo, 'ahead.txt'), 'ahead\n');
    run(repo, 'git', 'add', 'ahead.txt');
    run(repo, 'git', 'commit', '-m', 'ahead work');

    const branches = await service.getBranches(repo, null);
    const main = branches.find((b) => b.name === branch && !b.isRemote)!;
    expect(main.upstream).toBe(`origin/${branch}`);
    expect(main.ahead).toBe(1);
    // git 只在落后时才输出 behind，未落后时留空（null），不是 0
    expect(main.behind).toBeNull();
  });

  it('getBranchesOnUnbornRepositoryLeavesHashEmpty', async () => {
    const { dir, service } = await setupRepo();
    const unborn = join(dir, 'unborn');
    mkdirSync(unborn, { recursive: true });
    run(unborn, 'git', 'init');
    const branches = await service.getBranches(unborn, null);
    expect(branches.length).toBe(1);
    expect(branches[0].lastCommitHash).toBeNull();
    expect(branches[0].isCurrent).toBe(true);
  });

  it('getStashesListsEntriesWithMessageAndDate', async () => {
    const { service, repo } = await setupRepo();
    expect(await service.getStashes(repo, null)).toEqual([]);
    writeFileSync(join(repo, 'wip.txt'), 'wip\n');
    run(repo, 'git', 'add', 'wip.txt');
    run(repo, 'git', 'stash', 'push', '-m', 'mao-auto-pull-abc');

    const stashes = await service.getStashes(repo, null);
    expect(stashes.length).toBe(1);
    expect(stashes[0].ref).toBe('stash@{0}');
    expect(stashes[0].message).toContain('mao-auto-pull-abc');
    expect(stashes[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getRemotesMergesFetchAndPushUrlsAndSanitizesCredentials', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    run(repo, 'git', 'remote', 'add', 'origin', `https://user:token@example.com/remote.git`);
    run(repo, 'git', 'remote', 'set-url', '--push', 'origin', `https://user:token@example.com/push.git`);

    const remotes = await service.getRemotes(repo, null);
    expect(remotes.length).toBe(1);
    expect(remotes[0].name).toBe('origin');
    expect(remotes[0].fetchUrl).toBe('https://***@example.com/remote.git');
    expect(remotes[0].pushUrl).toBe('https://***@example.com/push.git');
    expect(branch).toBeTruthy();
  });
});
