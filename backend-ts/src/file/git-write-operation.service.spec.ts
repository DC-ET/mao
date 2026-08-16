import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-gwrite-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-grename-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-grefresh-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-gup-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-gfail-'));
    const repo = join(dir, 'failed-refresh');
    mkdirSync(repo, { recursive: true });
    run(repo, 'git', 'init');
    run(repo, 'git', 'config', 'user.name', 'Test');
    run(repo, 'git', 'config', 'user.email', 'a@b.c');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run(repo, 'git', 'add', '.');
    run(repo, 'git', 'commit', '-m', 'init');
    run(repo, 'git', 'remote', 'add', 'origin', 'https://user:secret@example.invalid/repo.git');

    const status = await newService(dir, repo).refreshRemoteStatus(session(repo), null);
    expect(status.isGit).toBe(true);
    expect(status.remoteStatusAvailable).toBe(false);
    expect(status.remoteStatusError).toBeTruthy();
    expect(status.remoteStatusError).not.toContain('user:secret');
  });

  it('multipleRemotesWithoutOriginCannotBeConfirmed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-gmulti-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mao-gcommit-'));
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
});
