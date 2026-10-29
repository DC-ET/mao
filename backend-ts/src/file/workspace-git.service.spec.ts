import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { useTmpDirOutsideRepo } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { BusinessException } from '../common/business-exception.js';
import { EXCLUDED_REPO_DIRS, WorkspaceGitService, firstObjectId } from './workspace-git.service.js';

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

/** 断言 promise 以 BusinessException 拒绝且 message 含指定片段（错误文案是契约的一部分）。 */
async function expectBusinessError(promise: Promise<unknown>, fragment: string): Promise<void> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(BusinessException);
  expect((error as BusinessException).message).toContain(fragment);
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

  // ===== Git 管理器中央 Tab：分支对比（只读，三点 <base>...<target>）=====

  it('compareBranchesCountsAheadBehindAndListsTargetOnlyFiles', async () => {
    const { service, repo, branch } = await setupRepo();
    run(repo, 'git', 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    run(repo, 'git', 'add', 'feature.txt');
    run(repo, 'git', 'commit', '-m', 'feature work');
    run(repo, 'git', 'checkout', '-q', branch);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', 'base.txt');
    run(repo, 'git', 'commit', '-m', 'base work');

    const result = await service.compareBranches(repo, null, branch, 'feature');
    expect(result.base).toBe(branch);
    expect(result.target).toBe('feature');
    // rev-list --left-right --count 的 left = 基准独有（behindCount）、right = 目标独有（aheadCount）
    expect(result.behindCount).toBe(1);
    expect(result.aheadCount).toBe(1);
    // 三点语义：只列目标侧独有的变更，基准侧独有的 base.txt 不算差异
    expect(result.files.map((f) => f.path)).toEqual(['feature.txt']);
    expect(result.files[0].changeType).toBe('CREATED');
    expect(result.files[0].insertions).toBe(1);
    expect(result.files[0].deletions).toBe(0);

    // 反过来对比：目标侧变成 base.txt
    const reversed = await service.compareBranches(repo, null, 'feature', branch);
    expect(reversed.aheadCount).toBe(1);
    expect(reversed.behindCount).toBe(1);
    expect(reversed.files.map((f) => f.path)).toEqual(['base.txt']);
  });

  it('compareBranchesReturnsEmptyListWhenThereIsNoDifference', async () => {
    const { service, repo, branch } = await setupRepo();
    // target 落后于 base（target 恰为 base 的祖先）：diff 输出为空且退出码 0，是合法空列表而非错误
    run(repo, 'git', 'branch', 'behind-branch');
    writeFileSync(join(repo, 'ahead.txt'), 'ahead\n');
    run(repo, 'git', 'add', 'ahead.txt');
    run(repo, 'git', 'commit', '-m', 'ahead');

    const behind = await service.compareBranches(repo, null, branch, 'behind-branch');
    expect(behind.files).toEqual([]);
    expect(behind.aheadCount).toBe(0);
    expect(behind.behindCount).toBe(1);

    // 同一分支自比：恒无差异
    const same = await service.compareBranches(repo, null, branch, branch);
    expect(same.files).toEqual([]);
    expect(same.aheadCount).toBe(0);
    expect(same.behindCount).toBe(0);
  });

  /** 改名 numstat 形态复现夹具：基准分支停在 oldRel→newRel 改名之前，返回 { service, repo, branch }。 */
  async function setupRenameCompare(oldRel: string, newRel: string, expectedNumstatFragment: string) {
    const { service, repo, branch } = await setupRepo();
    mkdirSync(join(repo, oldRel, '..'), { recursive: true });
    writeFileSync(join(repo, oldRel), 'a\nb\nc\nd\ne\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', `add ${oldRel}`);
    run(repo, 'git', 'branch', 'compare-base');
    mkdirSync(join(repo, newRel, '..'), { recursive: true });
    run(repo, 'git', 'mv', oldRel, newRel);
    writeFileSync(join(repo, newRel), 'a\nB\nc\nd\ne\nf\n');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', `rename ${oldRel} to ${newRel}`);
    // 夹具自检：git 对该形态确实输出预期的紧凑路径（否则用例失去复现前提）
    const numstat = run(repo, 'git', 'diff', '--numstat', `compare-base...${branch}`);
    expect(numstat, `git numstat for ${oldRel} => ${newRel}`).toContain(expectedNumstatFragment);
    return { service, repo, branch };
  }

  it('compareBranchesKeepsRenameLineStatsForBraceCompactNumstat', async () => {
    // 同目录改名：numstat 是花括号紧凑形态 `src/{a.txt => b.txt}`
    const { service, repo, branch } = await setupRenameCompare('src/a.txt', 'src/b.txt', 'src/{a.txt => b.txt}');
    const result = await service.compareBranches(repo, null, 'compare-base', branch);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.changeType).toBe('RENAMED');
    expect(file.path).toBe('src/b.txt');
    expect(file.oldPath).toBe('src/a.txt');
    // numstat 必须与 name-status 按键合并：漏还原紧凑形态则改名恒显 +0/-0
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it('compareBranchesKeepsRenameLineStatsForPlainArrowNumstat', async () => {
    // 跨目录改名（无共同前后缀）：numstat 是无花括号的 `old/a.txt => new/b.txt`
    const { service, repo, branch } = await setupRenameCompare('old/a.txt', 'new/b.txt', 'old/a.txt => new/b.txt');
    const result = await service.compareBranches(repo, null, 'compare-base', branch);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.changeType).toBe('RENAMED');
    expect(file.path).toBe('new/b.txt');
    expect(file.oldPath).toBe('old/a.txt');
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it('compareBranchesListsCreatedDeletedAndBinaryFiles', async () => {
    const { service, repo, branch } = await setupRepo();
    writeFileSync(join(repo, 'del.txt'), 'delete me\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'seed');
    run(repo, 'git', 'branch', 'compare-base');
    writeFileSync(join(repo, 'add.txt'), 'brand new\n');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 254]));
    run(repo, 'git', 'rm', '-q', 'del.txt');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'change');

    const result = await service.compareBranches(repo, null, 'compare-base', branch);
    expect(result.aheadCount).toBe(1);
    expect(result.behindCount).toBe(0);
    const added = result.files.find((f) => f.path === 'add.txt')!;
    expect(added.changeType).toBe('CREATED');
    expect(added.insertions).toBe(1);
    const deleted = result.files.find((f) => f.path === 'del.txt')!;
    expect(deleted.changeType).toBe('DELETED');
    expect(deleted.deletions).toBe(1);
    // 二进制：numstat 的两个计数都是 `-`，行数统计归零并标 binary
    const binary = result.files.find((f) => f.path === 'bin.dat')!;
    expect(binary.binary).toBe(true);
    expect(binary.insertions).toBe(0);
    expect(binary.deletions).toBe(0);
  });

  it('compareBranchesRejectsUnknownRefsAndInvalidBranchNames', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    await expectBusinessError(service.compareBranches(repo, null, branch, 'no-such-branch'), '分支不存在');
    await expectBusinessError(service.compareBranches(repo, null, 'no-such-branch', branch), '分支不存在');
    // 非法分支名：`-x` 只有在首字符排除 `-` 的严格正则下才会被拒（写侧 BRANCH_NAME_PATTERN 会放过）
    const invalid = ['-x', 'a..b', 'a~b', 'a@{b', '/a', 'a/', 'a//b', '.a', 'a.lock'];
    for (const name of invalid) {
      await expectBusinessError(service.compareBranches(repo, null, name, branch), '分支不存在');
      await expectBusinessError(service.compareBranches(repo, null, branch, name), '分支不存在');
    }
    // 上面的循环对宽松正则也能「靠 git 报错」通过，故补顺序断言：校验必须发生在仓库解析之前。
    // 非 git 目录 + 非法分支名 ⇒ 「分支不存在」；若校验放行（照抄写侧宽松字符类），
    // 会先撞 resolveRepoRoot 报「当前工作区不是 Git 仓库」。
    await expectBusinessError(service.compareBranches(dir, null, '-x', branch), '分支不存在');
    // 对照：同一非 git 目录 + 合法分支名才会走到仓库解析并报错（证明上一条命中的是分支名校验）
    await expectBusinessError(service.compareBranches(dir, null, branch, branch), '当前工作区不是 Git 仓库');
  });

  it('compareBranchesRejectsUnbornRepository', async () => {
    const { dir, service } = await setupRepo();
    const unborn = join(dir, 'unborn');
    mkdirSync(unborn, { recursive: true });
    run(unborn, 'git', 'init');
    // 空仓库：任何 ref 都 rev-parse 失败 → 「分支不存在」，不是「没有差异」
    await expectBusinessError(service.compareBranches(unborn, null, 'main', 'master'), '分支不存在');
  });

  it('compareBranchesRejectsUnrelatedHistories', async () => {
    const { service, repo, branch } = await setupRepo();
    run(repo, 'git', 'checkout', '-q', '--orphan', 'orphan');
    run(repo, 'git', 'rm', '-rf', '-q', '.');
    writeFileSync(join(repo, 'orphan.txt'), 'orphan\n');
    run(repo, 'git', 'add', 'orphan.txt');
    run(repo, 'git', 'commit', '-m', 'orphan root');
    // 无共同祖先：实测 rev-list 仍成功、git diff A...B 报 no merge base，判定只能落在 merge-base 退出码 1
    await expectBusinessError(service.compareBranches(repo, null, branch, 'orphan'), '两个分支没有共同祖先，无法对比');
  });

  it('compareBranchFileDiffCoversModifiedCreatedAndDeleted', async () => {
    const { service, repo, branch } = await setupRepo();
    writeFileSync(join(repo, 'mod.txt'), 'before\n');
    writeFileSync(join(repo, 'del.txt'), 'delete me\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'seed');
    run(repo, 'git', 'branch', 'compare-base');
    writeFileSync(join(repo, 'mod.txt'), 'after\n');
    writeFileSync(join(repo, 'add.txt'), 'brand new\n');
    run(repo, 'git', 'rm', '-q', 'del.txt');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'change');

    const modified = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'mod.txt');
    expect(modified.path).toBe('mod.txt');
    expect(modified.changeType).toBe('MODIFIED');
    expect(modified.beforeContent).toBe('before\n');
    expect(modified.afterContent).toBe('after\n');

    // merge-base 中不存在 → before 空（show 非零退出按空内容处理，不是错误）
    const created = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'add.txt');
    expect(created.changeType).toBe('CREATED');
    expect(created.beforeContent).toBe('');
    expect(created.afterContent).toBe('brand new\n');

    // target 中不存在 → after 空
    const deleted = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'del.txt');
    expect(deleted.changeType).toBe('DELETED');
    expect(deleted.beforeContent).toBe('delete me\n');
    expect(deleted.afterContent).toBe('');
  });

  it('compareBranchFileDiffReadsRenamedFileFromMergeBaseOldPath', async () => {
    const { service, repo, branch } = await setupRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'old content\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add src/a.txt');
    run(repo, 'git', 'branch', 'compare-base');
    run(repo, 'git', 'mv', 'src/a.txt', 'src/b.txt');
    writeFileSync(join(repo, 'src', 'b.txt'), 'new content\n');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'rename and edit');

    // 不传 oldPath：新路径在 merge-base 树中不存在，before 取空、退化成 CREATED（退化契约）
    const naive = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'src/b.txt');
    expect(naive.changeType).toBe('CREATED');
    expect(naive.beforeContent).toBe('');

    // 传 oldPath（清单 R 行的旧路径）：before 取 merge-base 的旧路径，changeType 对齐「改名」
    const renamed = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'src/b.txt', 'src/a.txt');
    expect(renamed.path).toBe('src/b.txt'); // 返回的 path 恒为新路径
    expect(renamed.changeType).toBe('RENAMED');
    expect(renamed.beforeContent).toBe('old content\n');
    expect(renamed.afterContent).toBe('new content\n');
  });

  it('compareBranchFileDiffTakesBeforeSideFromMergeBaseWhenBothSidesChangeTheFile', async () => {
    const { service, repo, branch } = await setupRepo();
    run(repo, 'git', 'branch', 'compare-base');
    run(repo, 'git', 'checkout', '-q', 'compare-base');
    writeFileSync(join(repo, 'README.md'), 'hello\nbase\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'base edit');
    run(repo, 'git', 'checkout', '-q', branch);
    writeFileSync(join(repo, 'README.md'), 'hello\ntarget\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'target edit');

    const diff = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'README.md');
    // before 端取 merge-base 而非 base tip：内容必须等于 git show <merge-base>:<file>
    const mergeBase = run(repo, 'git', 'merge-base', 'compare-base', branch).trim();
    expect(diff.beforeContent).toBe(run(repo, 'git', 'show', `${mergeBase}:README.md`));
    expect(diff.beforeContent).toBe('hello\n');
    // 基准分支独有的改动不得混进 before（否则与三点清单自相矛盾）
    expect(diff.beforeContent).not.toContain('base');
    expect(diff.afterContent).toBe('hello\ntarget\n');
    // 三点清单同样只列目标侧独有的 README.md
    const list = await service.compareBranches(repo, null, 'compare-base', branch);
    expect(list.files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('compareBranchFileDiffKeepsRenameWhenBaseSideDeletedTheOldPath', async () => {
    const { service, repo, branch } = await setupRepo();
    writeFileSync(join(repo, 'alpha.txt'), 'alpha content\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'add alpha');
    run(repo, 'git', 'branch', 'compare-base');
    // 基准侧删掉旧路径：before 端若误取 <base>，show 会落空、退化成 CREATED
    run(repo, 'git', 'checkout', '-q', 'compare-base');
    run(repo, 'git', 'rm', '-q', 'alpha.txt');
    run(repo, 'git', 'commit', '-m', 'base removes alpha');
    run(repo, 'git', 'checkout', '-q', branch);
    run(repo, 'git', 'mv', 'alpha.txt', 'beta.txt');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'target renames alpha');

    // 三点清单与单文件 diff 的「改名」徽章必须一致
    const list = await service.compareBranches(repo, null, 'compare-base', branch);
    expect(list.files).toHaveLength(1);
    expect(list.files[0].changeType).toBe('RENAMED');
    expect(list.files[0].path).toBe('beta.txt');
    expect(list.files[0].oldPath).toBe('alpha.txt');

    const diff = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'beta.txt', 'alpha.txt');
    expect(diff.changeType).toBe('RENAMED');
    expect(diff.beforeContent).toBe('alpha content\n');
    expect(diff.afterContent).toBe('alpha content\n');
  });

  it('compareBranchFileDiffMarksBinaryAndTruncatesLargeContent', async () => {
    const { service, repo, branch } = await setupRepo();
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 254]));
    writeFileSync(join(repo, 'big.txt'), Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n'));
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'seed');
    run(repo, 'git', 'branch', 'compare-base');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 0, 255, 254]));
    writeFileSync(join(repo, 'big.txt'), Array.from({ length: 6000 }, (_, i) => `changed ${i}`).join('\n'));
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'change');

    const binary = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'bin.dat');
    expect(binary.binary).toBe(true);
    expect(binary.unavailableReason).toBe('二进制文件，无法预览');
    expect(binary.beforeContent).toBe('');
    expect(binary.afterContent).toBe('');

    const big = await service.compareBranchFileDiff(repo, null, 'compare-base', branch, 'big.txt');
    expect(big.truncated).toBe(true);
    expect(big.beforeContent.split('\n')).toHaveLength(5000);
  });

  it('compareBranchFileDiffRejectsBadInputs', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    await expectBusinessError(service.compareBranchFileDiff(repo, null, branch, branch, '  '), '文件路径不能为空');
    await expectBusinessError(service.compareBranchFileDiff(repo, null, branch, branch, '../README.md'), '路径访问被拒绝');
    await expectBusinessError(service.compareBranchFileDiff(repo, null, branch, branch, 'README.md', '../secret.txt'), '路径访问被拒绝');
    // 分支名 / ref 校验：非法名与不存在的 ref 都是「分支不存在」
    await expectBusinessError(service.compareBranchFileDiff(repo, null, '-x', branch, 'README.md'), '分支不存在');
    await expectBusinessError(service.compareBranchFileDiff(repo, null, branch, 'a..b', 'README.md'), '分支不存在');
    await expectBusinessError(service.compareBranchFileDiff(repo, null, branch, 'no-such-branch', 'README.md'), '分支不存在');
    // 分支名校验先于仓库解析（同 compareBranches）：非 git 目录下仍是「分支不存在」
    await expectBusinessError(service.compareBranchFileDiff(dir, null, '-x', branch, 'README.md'), '分支不存在');
  });

  it('compareBranchFileDiffRejectsUnrelatedHistories', async () => {
    const { service, repo, branch } = await setupRepo();
    run(repo, 'git', 'checkout', '-q', '--orphan', 'orphan');
    run(repo, 'git', 'rm', '-rf', '-q', '.');
    writeFileSync(join(repo, 'orphan.txt'), 'orphan\n');
    run(repo, 'git', 'add', 'orphan.txt');
    run(repo, 'git', 'commit', '-m', 'orphan root');
    await expectBusinessError(
      service.compareBranchFileDiff(repo, null, branch, 'orphan', 'orphan.txt'),
      '两个分支没有共同祖先，无法对比',
    );
  });

  it('compareIgnoresSameNamedTagWhenResolvingBranchRefs', async () => {
    const { service, repo, branch } = await setupRepo();
    // 第三个提交 D：与 seed / target 都分叉（从 init 拉出）且不含 mod.txt，
    // 供两个同名 tag 指向它——若实现用裸 ref 名，会连 merge-base / show 都落到 D 上
    run(repo, 'git', 'checkout', '-q', '-b', 'cmp-other');
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    run(repo, 'git', 'add', 'other.txt');
    run(repo, 'git', 'commit', '-m', 'other work');
    run(repo, 'git', 'checkout', '-q', branch);
    writeFileSync(join(repo, 'mod.txt'), 'before\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'seed');
    run(repo, 'git', 'branch', 'cmp-base');
    run(repo, 'git', 'checkout', '-q', '-b', 'cmp-target');
    writeFileSync(join(repo, 'mod.txt'), 'after\n');
    run(repo, 'git', 'add', '-A');
    run(repo, 'git', 'commit', '-m', 'change');
    // 两个同名 tag 都指向 D：git 解析裸 ref 名时 refs/tags/ 优先于 refs/heads/，
    // 若实现用裸名比对，比到的就是 D（分叉的无关提交），计数与内容全错。
    // 建 tag 时写显式 ref 路径，避免夹具自己又被同名 ref 遮蔽。
    run(repo, 'git', 'tag', 'cmp-base', 'refs/heads/cmp-other');
    run(repo, 'git', 'tag', 'cmp-target', 'refs/heads/cmp-other');
    // 夹具自检：裸名确实被 tag 遮蔽到 D，与分支 ref 指向不同提交
    const bareBase = run(repo, 'git', 'rev-parse', '--verify', 'cmp-base').trim();
    expect(bareBase).toBe(run(repo, 'git', 'rev-parse', 'refs/tags/cmp-base').trim());
    expect(bareBase).not.toBe(run(repo, 'git', 'rev-parse', 'refs/heads/cmp-base').trim());

    // 必须按分支 ref 比对：target 领先 1（seed → change）、base 无独有提交；
    // 若被 tag 遮蔽则 base/target 都成 D，计数归零、清单为空
    const result = await service.compareBranches(repo, null, 'cmp-base', 'cmp-target');
    expect(result.base).toBe('cmp-base');
    expect(result.target).toBe('cmp-target');
    expect(result.aheadCount).toBe(1);
    expect(result.behindCount).toBe(0);
    expect(result.files.map((f) => f.path)).toEqual(['mod.txt']);
    expect(result.files[0].changeType).toBe('MODIFIED');
    // 行数统计来自 --numstat：numstat / name-status 任一步用了裸名，这里会退化成 +0/-0 或空清单
    expect(result.files[0].insertions).toBe(1);
    expect(result.files[0].deletions).toBe(1);

    // 单文件 diff 同样取分支内容：被 tag 遮蔽时 merge-base 成为 D，before/after 都会落空
    const diff = await service.compareBranchFileDiff(repo, null, 'cmp-base', 'cmp-target', 'mod.txt');
    expect(diff.changeType).toBe('MODIFIED');
    expect(diff.beforeContent).toBe('before\n');
    expect(diff.afterContent).toBe('after\n');
  });

  it('compareBranchesResolvesRemoteTrackingBranchNames', async () => {
    const { dir, service, repo, branch } = await setupRepo();
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);
    writeFileSync(join(repo, 'local.txt'), 'local\n');
    run(repo, 'git', 'add', 'local.txt');
    run(repo, 'git', 'commit', '-m', 'local work');

    // 远端跟踪分支名（origin/<branch>）走 refs/remotes/ 前缀的第二段解析
    const result = await service.compareBranches(repo, null, `origin/${branch}`, branch);
    expect(result.base).toBe(`origin/${branch}`);
    expect(result.aheadCount).toBe(1);
    expect(result.behindCount).toBe(0);
    expect(result.files.map((f) => f.path)).toEqual(['local.txt']);
    expect(result.files[0].changeType).toBe('CREATED');
  });

  it('firstObjectIdSkipsWarningLinesInMergedOutput', () => {
    // runGitRaw 合并 stdout+stderr：criss-cross 的 multiple merge bases 警告会混在首行
    const sha1 = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);
    expect(firstObjectId(`${sha1}\n`)).toBe(sha1);
    expect(firstObjectId(`warning: refname 'x' is ambiguous.\n${sha1}\n`)).toBe(sha1);
    expect(firstObjectId(`warning: some warning\n${sha256}\n`)).toBe(sha256);
    expect(firstObjectId('warning: something went wrong\n')).toBeNull();
    expect(firstObjectId('')).toBeNull();
  });
});
