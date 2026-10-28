import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { ActivityService } from '../session/activity.service.js';
import type { GitCredentialLookup, Session } from '../session/types.js';
import { GitCommitMessageService, MAX_DIFF_BYTES } from './git-commit-message.service.js';
import { GitWriteOperationService } from './git-write-operation.service.js';
import { WorkspaceGitService } from './workspace-git.service.js';

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

function session(repo: string): Session {
  return { id: 1, userId: 1, workspace: repo };
}

function newService(dir: string, repo: string): GitWriteOperationService {
  const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'refresh-sandbox')));
  const credentials: GitCredentialLookup = { getTokenMapByUser: vi.fn(async () => ({})) };
  return new GitWriteOperationService(
    workspace,
    { generate: vi.fn() } as unknown as GitCommitMessageService,
    credentials,
    {} as RuntimeDataResolver,
    { record: vi.fn() } as unknown as ActivityService,
  );
}

const describeGit = gitAvailable() ? describe : describe.skip;

describeGit('GitWriteOperationService git', () => {
  it('commitInputFiltersSensitiveAndBinaryAndFairlyTruncates', async () => {
    const dir = useTmpDir('mao-gwrite-');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    writeFileSync(join(repo, 'a.txt'), 'a'.repeat(150_000));
    writeFileSync(join(repo, 'b.txt'), 'b'.repeat(150_000));
    writeFileSync(join(repo, '.env'), 'SECRET=value');
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2]));

    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate: vi.fn() } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );
    const input = await service.buildCommitInput(repo, await workspace.changedFiles(repo));
    expect(input.files).toHaveLength(4);
    expect(input.diffBytes).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(input.truncated).toBe(true);
    expect(input.files.find((f) => f.path === 'a.txt')?.diff).toBeTruthy();
    expect(input.files.find((f) => f.path === 'b.txt')?.diff).toBeTruthy();
    expect(input.files.find((f) => f.path === '.env')?.diff).toBeUndefined();
    expect(input.files.find((f) => f.path === 'image.bin')?.diff).toBeUndefined();
  });

  it('renamedSensitivePathNeverIncludesDiff', async () => {
    const dir = useTmpDir('mao-grename-');
    const repo = join(dir, 'renamed');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, '.env'), 'SECRET=never-upload\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    run(repo, 'git', 'mv', '.env', 'config.txt');

    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'rename-sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate: vi.fn() } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );
    const input = await service.buildCommitInput(repo, await workspace.changedFiles(repo));
    const renamed = input.files[0];
    expect(renamed.path).toBe('config.txt');
    expect(renamed.sensitive).toBe(true);
    expect(renamed.diff).toBeUndefined();
  });

  it('refreshFetchesSelectedRemoteAndReportsAheadBehind', async () => {
    const dir = useTmpDir('mao-grefresh-');
    const remote = join(dir, 'remote.git');
    run(dir, 'git', 'init', '--bare', remote);
    const repo = join(dir, 'refresh-repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    const branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);

    const other = join(dir, 'other');
    run(dir, 'git', 'clone', remote, other);
    run(other, 'git', 'config', 'user.name', 'Other');
    run(other, 'git', 'config', 'user.email', 'other@example.com');
    writeFileSync(join(other, 'remote.txt'), 'remote\n');
    run(other, 'git', 'add', '.');
    run(other, 'git', 'commit', '-m', 'remote');
    run(other, 'git', 'push');

    const status = await newService(dir, repo).refreshRemoteStatus(session(repo), null);
    expect(status.remoteStatusAvailable).toBe(true);
    expect(status.remoteStatusError ?? null).toBeNull();
    expect(status.aheadCount).toBe(0);
    expect(status.behindCount).toBe(1);
    expect(status.hasHead).toBe(true);
  });

  it('refreshPrefersUpstreamRemoteOverOrigin', async () => {
    const dir = useTmpDir('mao-gup-');
    const upstream = join(dir, 'upstream.git');
    run(dir, 'git', 'init', '--bare', upstream);
    const repo = join(dir, 'upstream-refresh');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    const branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    run(repo, 'git', 'remote', 'add', 'upstream', upstream);
    run(repo, 'git', 'push', '-u', 'upstream', branch);
    run(repo, 'git', 'remote', 'add', 'origin', 'https://invalid:secret@example.invalid/repo.git');

    const status = await newService(dir, repo).refreshRemoteStatus(session(repo), null);
    expect(status.remoteStatusAvailable).toBe(true);
    expect(status.remoteStatusError ?? null).toBeNull();
  });

  it('refreshFailureReturnsLocalStatusAndSanitizedError', async () => {
    const dir = useTmpDir('mao-gfail-');
    const repo = join(dir, 'failed-refresh');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    // 远端不可达。刻意避开 `*.invalid` 域名：本机配了 HTTP(S)_PROXY 时 git 会把
    // 这类保留域名交给代理，代理握手失败要 5-10s，超过 vitest 5s 默认超时。
    // 用「带凭证的 http:// 指向本地关闭端口」构造同样的失败：端口拒连是毫秒级、
    // 与代理配置无关（127.0.0.1 在 NO_PROXY 内），URL 里仍含 user:secret，
    // 因此错误消毒断言（不得泄露 user:secret）保持原样有效。
    run(repo, 'git', 'remote', 'add', 'origin', 'http://user:secret@127.0.0.1:1/repo.git');

    const status = await newService(dir, repo).refreshRemoteStatus(session(repo), null);
    expect(status.isGit).toBe(true);
    expect(status.remoteStatusAvailable).toBe(false);
    expect(status.remoteStatusError).toBeTruthy();
    expect(status.remoteStatusError).not.toContain('user:secret');
  });

  it('multipleRemotesWithoutOriginCannotBeConfirmed', async () => {
    const dir = useTmpDir('mao-gmulti-');
    const repo = join(dir, 'multi-remote');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    run(repo, 'git', 'remote', 'add', 'alpha', join(dir, 'alpha.git'));
    run(repo, 'git', 'remote', 'add', 'beta', join(dir, 'beta.git'));

    const status = await newService(dir, repo).refreshRemoteStatus(session(repo), null);
    expect(status.remoteStatusAvailable).toBe(false);
    expect(status.remoteStatusError).toContain('多个远端');
  });

  it('commits local changes and records local activity', async () => {
    const dir = useTmpDir('mao-gcommit-');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    writeFileSync(join(repo, 'base.txt'), 'changed\n');
    const activity = { record: vi.fn() };
    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate: vi.fn(async () => ({ message: 'update base', title: 'update' })) } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      activity as unknown as ActivityService,
    );
    const result = await service.commit(session(repo), null);
    expect(result.success).toBe(true);
    expect(result.commitTitle).toBe('update');
    await service.recordLocalActivity(session(repo), {
      operation: 'commit', success: true, repoPath: repo, branch: 'main', commitHash: 'abc', commitTitle: 't',
    });
    expect(activity.record).toHaveBeenCalled();
    await expect(service.recordLocalActivity(session(repo), { operation: 'noop', success: true })).rejects.toThrow();
  });

  // ===== 两步提交（中央 Tab）：传入消息直接提交 + 只生成不提交 =====

  async function setupChangedRepo(dir: string): Promise<string> {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    writeFileSync(join(repo, 'base.txt'), 'changed\n');
    return repo;
  }

  it('commitsWithProvidedMessageSkippingGeneration', async () => {
    const dir = useTmpDir('mao-gcommitmsg-');
    const repo = await setupChangedRepo(dir);
    const generate = vi.fn(async () => ({ message: 'feat: llm\n\n- llm body', title: 'feat: llm' }));
    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );

    // 用户自由格式的消息（非 Conventional Commits、多段正文）原样落库，不走 LLM
    const message = 'wip 随手一改\n\n第二段：补充说明';
    const result = await service.commit(session(repo), null, message);
    expect(result.success).toBe(true);
    expect(result.commitTitle).toBe('wip 随手一改');
    expect(generate).not.toHaveBeenCalled();
    // 单个 -m 传入：git 不会用空行拼接改写原文
    expect(run(repo, 'git', 'log', '-1', '--pretty=%B').trim()).toBe(message);
  });

  it('rejectsBlankProvidedCommitMessage', async () => {
    const dir = useTmpDir('mao-gcommitblank-');
    const repo = await setupChangedRepo(dir);
    const headBefore = run(repo, 'git', 'rev-parse', 'HEAD').trim();
    const service = new GitWriteOperationService(
      new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox'))),
      { generate: vi.fn() } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );

    await expect(service.commit(session(repo), null, '   ')).rejects.toThrow('提交信息不能为空');
    // 校验不过不产生提交
    expect(run(repo, 'git', 'rev-parse', 'HEAD').trim()).toBe(headBefore);
  });

  it('generateCommitMessageGeneratesWithoutCommitting', async () => {
    const dir = useTmpDir('mao-ggen-');
    const repo = await setupChangedRepo(dir);
    const headBefore = run(repo, 'git', 'rev-parse', 'HEAD').trim();
    const generate = vi.fn(async () => ({ message: 'docs: 改文档\n\n- 更新 base.txt', title: 'docs: 改文档' }));
    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );

    const generated = await service.generateCommitMessage(session(repo), null);
    expect(generated.title).toBe('docs: 改文档');
    expect(generated.message).toBe('docs: 改文档\n\n- 更新 base.txt');
    expect(generate).toHaveBeenCalled();
    // 不落提交、变更仍在（等用户在输入框确认后再提交）
    expect(run(repo, 'git', 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect((await workspace.changedFiles(repo)).size).toBe(1);
  });

  it('generateCommitMessageWithoutChangesFails', async () => {
    const dir = useTmpDir('mao-ggenempty-');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    const service = new GitWriteOperationService(
      new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox'))),
      { generate: vi.fn() } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      { record: vi.fn() } as unknown as ActivityService,
    );

    await expect(service.generateCommitMessage(session(repo), null)).rejects.toThrow('没有待提交的变更');
  });

  // ===== Git 管理器中央 Tab：写扩展 =====

  async function setupRemoteRepo(dir: string, name: string): Promise<{ repo: string; remote: string; branch: string }> {
    const remote = join(dir, `${name}.git`);
    run(dir, 'git', 'init', '--bare', remote);
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    const branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    run(repo, 'git', 'remote', 'add', 'origin', remote);
    run(repo, 'git', 'push', '-u', 'origin', branch);
    return { repo, remote, branch };
  }

  it('fetchRemoteFetchesPrunedRemote', async () => {
    const dir = useTmpDir('mao-gfetch-');
    const { repo, remote, branch } = await setupRemoteRepo(dir, 'fetch-repo');

    const other = join(dir, 'other');
    run(dir, 'git', 'clone', remote, other);
    run(other, 'git', 'config', 'user.name', 'Other');
    run(other, 'git', 'config', 'user.email', 'other@example.com');
    writeFileSync(join(other, 'remote.txt'), 'remote\n');
    run(other, 'git', 'add', '.');
    run(other, 'git', 'commit', '-m', 'remote');
    run(other, 'git', 'push');

    const service = newService(dir, repo);
    const result = await service.fetchRemote(session(repo), null);
    expect(result.success).toBe(true);
    expect(result.operation).toBe('fetch');
    expect(result.message).toBe('远端已更新');
    // fetch 后本地远端跟踪引用到位：behind 立刻可见
    const status = await service.refreshRemoteStatus(session(repo), null);
    expect(status.behindCount).toBe(1);
    expect(branch).toBeTruthy();
  });

  it('fetchRemoteWithoutRemoteFails', async () => {
    const dir = useTmpDir('mao-gfetch-none-');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');

    await expect(newService(dir, repo).fetchRemote(session(repo), null))
      .rejects.toThrow('仓库未配置远端');
  });

  it('switchBranchStashesAndRestoresLocalChanges', async () => {
    const dir = useTmpDir('mao-gswitch-');
    const { repo, branch } = await setupRemoteRepo(dir, 'switch-repo');
    run(repo, 'git', 'checkout', '-q', '-b', 'feature');

    // 未提交变更：切换时应自动 stash 并在切换后恢复（残留则说明编排漏了恢复）
    writeFileSync(join(repo, 'base.txt'), 'local edit\n');
    const result = await newService(dir, repo).switchBranch(session(repo), null, branch);
    expect(result.success).toBe(true);
    expect(result.operation).toBe('switch');
    expect(result.branch).toBe(branch);
    expect(result.message).toBe(`已切换到分支 ${branch}`);
    expect(run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(run(repo, 'git', 'stash', 'list')).toBe('');
    expect(require('node:fs').readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('local edit\n');
  });

  it('switchBranchCreatesTrackingBranchFromRemoteRef', async () => {
    const dir = useTmpDir('mao-gswitch-track-');
    const { repo, remote, branch } = await setupRemoteRepo(dir, 'track-repo');
    // 别处推一个新分支，本地只有 origin/<branch>-side 的远端跟踪引用
    const other = join(dir, 'other');
    run(dir, 'git', 'clone', remote, other);
    run(other, 'git', 'config', 'user.name', 'Other');
    run(other, 'git', 'config', 'user.email', 'other@example.com');
    run(other, 'git', 'checkout', '-q', '-b', 'side');
    writeFileSync(join(other, 'side.txt'), 'side\n');
    run(other, 'git', 'add', '.');
    run(other, 'git', 'commit', '-m', 'side work');
    run(other, 'git', 'push', '-u', 'origin', 'side');
    await newService(dir, repo).fetchRemote(session(repo), null);

    const result = await newService(dir, repo).switchBranch(session(repo), null, 'origin/side');
    expect(result.success).toBe(true);
    expect(result.branch).toBe('side');
    expect(run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('side');
    expect(run(repo, 'git', 'rev-parse', '--abbrev-ref', 'side@{upstream}').trim()).toBe('origin/side');
    expect(branch).toBeTruthy();
  });

  it('switchBranchRejectsDetachedHead', async () => {
    const dir = useTmpDir('mao-gswitch-detached-');
    const { repo } = await setupRemoteRepo(dir, 'detached-repo');
    run(repo, 'git', 'checkout', '-q', '--detach', 'HEAD');

    await expect(newService(dir, repo).switchBranch(session(repo), null, 'main'))
      .rejects.toThrow('detached HEAD');
  });

  it('switchBranchRejectsInvalidBranchName', async () => {
    const dir = useTmpDir('mao-gswitch-invalid-');
    const { repo } = await setupRemoteRepo(dir, 'invalid-repo');
    await expect(newService(dir, repo).switchBranch(session(repo), null, 'bad..name'))
      .rejects.toThrow('分支名无效');
    await expect(newService(dir, repo).switchBranch(session(repo), null, 'no-such-branch'))
      .rejects.toThrow();
  });

  it('stashOpApplyPopDropRoundTrip', async () => {
    const dir = useTmpDir('mao-gstash-');
    const { repo } = await setupRemoteRepo(dir, 'stash-repo');
    writeFileSync(join(repo, 'base.txt'), 'stashed\n');
    run(repo, 'git', 'stash', 'push', '-m', 'wip');

    const service = newService(dir, repo);
    const applied = await service.stashOp(session(repo), null, 'apply', 'stash@{0}');
    expect(applied.success).toBe(true);
    expect(applied.operation).toBe('stash');
    expect(applied.message).toBe('已应用 stash@{0}');
    expect(applied.stashRef).toBe('stash@{0}');
    // apply 不弹出：stash 仍在
    expect(run(repo, 'git', 'stash', 'list')).toContain('stash@{0}');

    run(repo, 'git', 'checkout', '-q', '--', 'base.txt');
    const popped = await service.stashOp(session(repo), null, 'pop', 'stash@{0}');
    expect(popped.success).toBe(true);
    expect(popped.message).toBe('已弹出 stash@{0}');
    // pop 弹出后列表清空
    expect(run(repo, 'git', 'stash', 'list')).toBe('');

    run(repo, 'git', 'stash', 'push', '-m', 'to drop');
    const dropped = await service.stashOp(session(repo), null, 'drop', 'stash@{0}');
    expect(dropped.success).toBe(true);
    expect(dropped.message).toBe('已丢弃 stash@{0}');
    expect(run(repo, 'git', 'stash', 'list')).toBe('');
  });

  it('stashOpApplyConflictReportsConflictAndKeepsTheScene', async () => {
    const dir = useTmpDir('mao-gstash-conflict-');
    const { repo } = await setupRemoteRepo(dir, 'stash-conflict-repo');
    // 构造与 stash 冲突的工作区：stash 改 base.txt，HEAD 后又改了同一文件
    writeFileSync(join(repo, 'base.txt'), 'stashed change\n');
    run(repo, 'git', 'stash', 'push', '-m', 'wip conflict');
    writeFileSync(join(repo, 'base.txt'), 'head change\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'diverge base.txt');

    const service = newService(dir, repo);
    // git stash apply 冲突时退出码为 1：必须走冲突契约（conflict + 保留现场引导），
    // 而不是裸 git 错误——否则契约里的 conflict/stashRef 全丢
    const applied = await service.stashOp(session(repo), null, 'apply', 'stash@{0}');
    expect(applied.success).toBe(false);
    expect(applied.conflict).toBe(true);
    expect(applied.stashRef).toBe('stash@{0}');
    expect(applied.error).toContain('已保留现场');
    expect(applied.error).toContain('stash@{0}');
    // 现场保留：stash 条目仍在（git 冲突时不 drop），工作区留下冲突标记
    expect(run(repo, 'git', 'stash', 'list')).toContain('wip conflict');
    expect(run(repo, 'git', 'status', '--porcelain')).toContain('UU base.txt');
  });

  it('stashOpRejectsUnknownActionAndBadRef', async () => {
    const dir = useTmpDir('mao-gstash-invalid-');
    const { repo } = await setupRemoteRepo(dir, 'stash-invalid-repo');
    const service = newService(dir, repo);
    await expect(service.stashOp(session(repo), null, 'save', 'stash@{0}'))
      .rejects.toThrow('stash 操作类型无效');
    await expect(service.stashOp(session(repo), null, 'apply', 'not-a-ref'))
      .rejects.toThrow('stash 引用无效');
    await expect(service.stashOp(session(repo), null, 'apply', 'stash@{0'))
      .rejects.toThrow('stash 引用无效');
    // 格式合法但 git 中不存在：由 git 运行时拒绝（不是校验消息）
    await expect(service.stashOp(session(repo), null, 'apply', 'stash@{99}'))
      .rejects.toThrow('stash apply 失败');
  });

  it('localActivityWhitelistCoversFetchSwitchAndStash', async () => {
    const dir = useTmpDir('mao-glocal-');
    const { repo } = await setupRemoteRepo(dir, 'local-activity-repo');
    const activity = { record: vi.fn() };
    const workspace = new WorkspaceGitService(new PathSandbox(join(dir, 'sandbox')));
    const service = new GitWriteOperationService(
      workspace,
      { generate: vi.fn() } as unknown as GitCommitMessageService,
      { getTokenMapByUser: vi.fn(async () => ({})) },
      {} as RuntimeDataResolver,
      activity as unknown as ActivityService,
    );
    for (const operation of ['fetch', 'switch', 'stash']) {
      await service.recordLocalActivity(session(repo), { operation, success: true, repoPath: repo });
    }
    expect(activity.record).toHaveBeenCalledTimes(3);
    expect(activity.record.mock.calls.map((c) => c[1])).toEqual(['GIT_FETCH', 'GIT_SWITCH', 'GIT_STASH']);
  });
});
