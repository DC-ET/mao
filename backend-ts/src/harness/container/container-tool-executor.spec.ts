import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerToolExecutor } from './container-tool-executor.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

const USER_ID = 7;

function envelopeOf(
  workspace: string | null,
  sessionId = 11,
  depsEnv: Record<string, string> = {},
  envVars: Record<string, string> = {},
): RuntimeEnvelope {
  return {
    userId: USER_ID,
    sessionId,
    workspace,
    home: '/tmp',
    runtimeDir: '/tmp/rt',
    gitTokens: {},
    maoToken: null,
    ecpToken: null,
    larkUat: null,
    depsEnv,
    envVars,
  };
}

describe('container tool executor', () => {
  it('executesFileToolsInsideSandboxAndRejectsEscapes', async () => {
    const base = useTmpDir('mao-exec-');
    // roots 用生产口径的全局父目录（宿主机配置原值，绝对路径与容器内一致）
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userHomeDir = join(base, 'users');
    const userSkillsDir = join(base, 'userskills');
    const userWorkspace = join(workspaceRoot, '7', 'projects', 'demo');
    const otherUser = join(userHomeDir, '8');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(runtimeDir, '7'), { recursive: true });
    mkdirSync(otherUser, { recursive: true });
    writeFileSync(join(userWorkspace, 'a.txt'), 'hello container');
    writeFileSync(join(otherUser, 'secret.txt'), 'foreign');

    const executor = new ContainerToolExecutor({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir, skillViewsDir: join(base, 'skill-views'), uploadDir: join(base, 'uploads'), shareDir: join(base, 'share') }, USER_ID);

    // read_file 工作区相对路径
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: 'a.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(read).content).toBe('hello container');

    // write_file 工作区内（返回 success 结构而非 content）
    const write = await executor.handleToolCall('write_file', JSON.stringify({ path: 'b.txt', content: 'written' }), envelopeOf(userWorkspace));
    expect(JSON.parse(write).success).toBe(true);
    expect(readFileSync(join(userWorkspace, 'b.txt'), 'utf8')).toBe('written');

    // 越界绝对路径拒绝（容器内严格 resolve）
    const escape = await executor.handleToolCall('read_file', JSON.stringify({ path: join(otherUser, 'secret.txt') }), envelopeOf(userWorkspace));
    expect(JSON.parse(escape).error).toBeDefined();

    // 相对穿越拒绝
    const traverse = await executor.handleToolCall('read_file', JSON.stringify({ path: '../8/secret.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(traverse).error).toBeDefined();

    // glob_search 越界拒绝
    const glob = await executor.handleToolCall('glob_search', JSON.stringify({ pattern: '**/*.txt', path: otherUser }), envelopeOf(userWorkspace));
    expect(JSON.parse(glob).error).toBeDefined();
  });

  it('allowsOnlyPerUserRootsNotGlobalParents', async () => {
    // BUG-11 回归：允许根必须是每用户子目录，全局父目录（users/8、runtime/8、userskills/8）一律拒绝
    const base = useTmpDir('mao-exec-peruser-');
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userHomeDir = join(base, 'users');
    const userSkillsDir = join(base, 'userskills');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    for (const dir of [join(runtimeDir, '8'), otherHome(userHomeDir), join(userSkillsDir, '8'), join(workspaceRoot, '8')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'secret.txt'), 'foreign');
    }
    const executor = new ContainerToolExecutor({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir, skillViewsDir: join(base, 'skill-views'), uploadDir: join(base, 'uploads'), shareDir: join(base, 'share') }, USER_ID);
    const env = envelopeOf(userWorkspace);

    for (const path of [
      join(runtimeDir, '8', 'secret.txt'),
      join(userHomeDir, '8', 'secret.txt'),
      join(userSkillsDir, '8', 'secret.txt'),
      join(workspaceRoot, '8', 'secret.txt'),
    ]) {
      const read = await executor.handleToolCall('read_file', JSON.stringify({ path }), env);
      expect(JSON.parse(read).error, `expected rejection for ${path}`).toBeDefined();
    }

    // 自己的每用户根照常放行
    mkdirSync(join(userHomeDir, '7'), { recursive: true });
    writeFileSync(join(userHomeDir, '7', 'mine.txt'), 'mine');
    const own = await executor.handleToolCall('read_file', JSON.stringify({ path: join(userHomeDir, '7', 'mine.txt') }), env);
    expect(JSON.parse(own).content).toBe('mine');
  });

  it('readBytesEnforcesSandboxAndSizeLimit', () => {
    const base = useTmpDir('mao-exec-bytes-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    writeFileSync(join(userWorkspace, 'pic.txt'), 'A'.repeat(100));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const env = envelopeOf(userWorkspace);

    const ok = executor.handleReadBytes('pic.txt', 1000, env);
    expect(ok.ok).toBe(true);
    expect(Buffer.from((ok as { base64: string }).base64, 'base64').length).toBe(100);

    const tooBig = executor.handleReadBytes('pic.txt', 10, env);
    expect(tooBig.ok).toBe(false);

    const missing = executor.handleReadBytes('nope.txt', 1000, env);
    expect(missing.ok).toBe(false);

    // /tmp 在容器内允许根（§5.6）
    writeFileSync('/tmp/mao-exec-tmpfile', 'tmp-bytes');
    try {
      const tmp = executor.handleReadBytes('/tmp/mao-exec-tmpfile', 1000, env);
      expect(tmp.ok).toBe(true);
    } finally {
      rmSync('/tmp/mao-exec-tmpfile', { force: true });
    }
  });

  it('allowsOwnUploadsArtifactsAndRejectsOtherUsers', async () => {
    // 图片产物按用户隔离：容器内 read_file / read_bytes 放行 {uploadDir}/{uid}，跨用户拒绝
    const base = useTmpDir('mao-exec-uploads-');
    const workspaceRoot = join(base, 'workspace');
    const uploadDir = join(base, 'uploads');
    const shareDir = join(base, 'share');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(uploadDir, '7'), { recursive: true });
    mkdirSync(join(uploadDir, '8'), { recursive: true });
    writeFileSync(join(uploadDir, '7', 'gen-x.txt'), 'own-image');
    writeFileSync(join(uploadDir, '8', 'gen-y.txt'), 'foreign');
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir,
      shareDir,
    }, USER_ID);
    const env = envelopeOf(userWorkspace);

    const own = await executor.handleToolCall('read_file', JSON.stringify({ path: join(uploadDir, '7', 'gen-x.txt') }), env);
    expect(JSON.parse(own).content).toBe('own-image');
    const other = await executor.handleToolCall('read_file', JSON.stringify({ path: join(uploadDir, '8', 'gen-y.txt') }), env);
    expect(JSON.parse(other).error).toBeDefined();

    // read_bytes 桥（外部发送工具容器读字节）同口径
    const ownBytes = executor.handleReadBytes(join(uploadDir, '7', 'gen-x.txt'), 1000, env);
    expect(ownBytes.ok).toBe(true);
    const otherBytes = executor.handleReadBytes(join(uploadDir, '8', 'gen-y.txt'), 1000, env);
    expect(otherBytes.ok).toBe(false);
  });

  it('readsFileUnderShareRoot', async () => {
    // 共享目录方案 §4.2：shareDir 是唯一跨用户共享的允许根，容器内 read_file 传绝对
    // 路径可读；share 内指向外部的 symlink 被 strict resolve + realpath 逃逸检测拒绝
    const base = useTmpDir('mao-exec-share-');
    const workspaceRoot = join(base, 'workspace');
    const shareDir = join(base, 'share');
    const userWorkspace = join(workspaceRoot, '7');
    const outside = join(base, 'outside');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(shareDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(shareDir, 'public.txt'), 'shared-content');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(shareDir, 'escape.txt'));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir,
    }, USER_ID);
    const env = envelopeOf(userWorkspace);

    // share 内公共文件按绝对路径可读
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: join(shareDir, 'public.txt') }), env);
    expect(JSON.parse(read).content).toBe('shared-content');
    // read_bytes 桥同口径
    const bytes = executor.handleReadBytes(join(shareDir, 'public.txt'), 1000, env);
    expect(bytes.ok).toBe(true);
    // share 内指向外部的 symlink 被逃逸检测拒绝
    const escape = await executor.handleToolCall('read_file', JSON.stringify({ path: join(shareDir, 'escape.txt') }), env);
    expect(JSON.parse(escape).error).toBeDefined();
  });

  it('readsSessionSkillSymlinkUnderSkillViewsRoot', async () => {
    // 技术方案 2026-11-03 §7.1：会话技能是 {runtimeDir}/{u}/{s}/skills/{name} ->
    // {skillViewsDir}/{u}/{name} 的符号链接（SkillSyncService 指向用户级只读视图），
    // 视图按用户登记为允许根后经 strict 校验可读；指向视图之外的链接仍被拒绝。
    const base = useTmpDir('mao-exec-skills-');
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userWorkspace = join(workspaceRoot, '7');
    const skillViewsDir = join(base, 'skill-views');
    const viewDir = join(skillViewsDir, '7', 'bigdata-cli');
    const otherViewDir = join(skillViewsDir, '8', 'bigdata-cli');
    const sessionSkillsDir = join(runtimeDir, '7', '11', 'skills');
    const outside = join(base, 'outside');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(viewDir, { recursive: true });
    mkdirSync(otherViewDir, { recursive: true });
    mkdirSync(sessionSkillsDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(viewDir, 'SKILL.md'), '---\nname: bigdata-cli\n---\nbody');
    writeFileSync(join(otherViewDir, 'SKILL.md'), '---\nname: bigdata-cli\n---\nother');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(viewDir, join(sessionSkillsDir, 'bigdata-cli'), 'dir');
    symlinkSync(otherViewDir, join(sessionSkillsDir, 'other-user-view'), 'dir');
    symlinkSync(outside, join(sessionSkillsDir, 'leak'), 'dir');
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir,
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir,
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const env = envelopeOf(userWorkspace);

    // read_file / read_bytes 同口径放行（技能 SKILL.md 在系统提示词里就是这条绝对路径）
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: join(sessionSkillsDir, 'bigdata-cli', 'SKILL.md') }), env);
    expect(JSON.parse(read).content).toContain('name: bigdata-cli');
    const bytes = executor.handleReadBytes(join(sessionSkillsDir, 'bigdata-cli', 'SKILL.md'), 1000, env);
    expect(bytes.ok).toBe(true);

    // 只放行本人视图：指向其他用户视图 / 视图之外的会话技能链接仍按符号链接逃逸拒绝
    const otherView = await executor.handleToolCall('read_file', JSON.stringify({ path: join(sessionSkillsDir, 'other-user-view', 'SKILL.md') }), env);
    expect(JSON.parse(otherView).error).toBeDefined();
    const escape = await executor.handleToolCall('read_file', JSON.stringify({ path: join(sessionSkillsDir, 'leak', 'secret.txt') }), env);
    expect(JSON.parse(escape).error).toBeDefined();
  });

  it('shellWorkdirUnderShareRootIsAllowed', async () => {
    // 设计 §1.2 目标 2 / CHANGELOG：shell 对 share 可达（与 read_file 同一
    // resolveLenient 代码路径）。补 shell workdir 一例（round-02 review 观察 2：
    // 此前只有 read_file 有覆盖）
    const base = useTmpDir('mao-exec-share-shell-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const shareDir = join(base, 'share');
    const shareSub = join(shareDir, 'docs');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(shareSub, { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir,
    }, USER_ID);
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec', command: 'pwd', workdir: shareSub,
    }), envelopeOf(userWorkspace));
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain(shareSub);
  });

  it('shellToolRejectsForeignWorkdirInStrictMode', async () => {
    const base = useTmpDir('mao-exec-shell-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const otherUser = join(base, 'users', '8');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(otherUser, { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    // workdir 越界（他人目录）被严格 resolve 拒绝
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec', command: 'pwd', workdir: otherUser,
    }), envelopeOf(userWorkspace));
    expect(JSON.parse(result).error).toBeDefined();
  });

  it('handlesSymlinkEscapeInWorkspace', async () => {
    const base = useTmpDir('mao-exec-link-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const outside = join(base, 'outside');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(join(outside, 'note.txt'), join(userWorkspace, 'leak.txt'));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: 'leak.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(read).error).toBeDefined();
  });

  it('injectsDepsEnvIntoShellSessions', async () => {
    // BUG-8 回归：§5.13 deps env 必须到达容器内 shell 子进程（npm/pip 安装落到 /deps 挂载）
    const base = useTmpDir('mao-exec-deps-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const depsUserDir = join(base, 'deps', '7');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(depsUserDir, 'npm', 'bin'), { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const depsEnv = {
      NPM_CONFIG_PREFIX: join(depsUserDir, 'npm'),
      PIP_TARGET: join(depsUserDir, 'py'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      MAO_DEPS_BIN: join(depsUserDir, 'npm', 'bin'),
    };
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec',
      command: 'echo "NPM=[$NPM_CONFIG_PREFIX] PIP=[$PIP_TARGET] BRK=[$PIP_BREAK_SYSTEM_PACKAGES] BIN=[$MAO_DEPS_BIN] PATH=[$PATH]"',
      yield_time_ms: 8000,
    }), envelopeOf(userWorkspace, 11, depsEnv));
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain(`NPM=[${depsEnv.NPM_CONFIG_PREFIX}]`);
    expect(parsed.output).toContain(`PIP=[${depsEnv.PIP_TARGET}]`);
    expect(parsed.output).toContain('BRK=[1]');
    // deps bin 前置进 PATH
    expect(parsed.output).toContain(`BIN=[${depsEnv.MAO_DEPS_BIN}]`);
    expect(parsed.output).toContain(`PATH=[${depsEnv.MAO_DEPS_BIN}:`);
  });

  it('injectsThreeLayerEnvVarsFromEnvelopeAndFiltersReservedKeys', async () => {
    const base = useTmpDir('mao-exec-env-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, String(USER_ID), 'proj');
    mkdirSync(userWorkspace, { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec',
      command: 'echo "REG=[$NPM_REGISTRY] PATHHEAD=[${PATH%%:*}]"',
      keep_session: true,
      yield_time_ms: 8000,
    }), envelopeOf(userWorkspace, 11, {}, { NPM_REGISTRY: 'https://mirror.internal', PATH: '/evil' }));
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain('REG=[https://mirror.internal]');
    // 保留键（PATH）不得被 envelope 里的条目覆盖
    expect(parsed.output).not.toContain('PATHHEAD=[/evil]');
  });

  it('keepsDepsBinIdempotentAcrossExecsInPersistentSession', async () => {
    // N-1 回归：持久 shell 会话每条 exec 前都会 refresh env，deps bin 只能前置一份，
    // 否则 PATH 随命令条数无界增长（旧实现 6 条命令后含 7 份 deps bin）
    const base = useTmpDir('mao-exec-deps-idem-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const depsUserDir = join(base, 'deps', '7');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(depsUserDir, 'npm', 'bin'), { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const depsBin = join(depsUserDir, 'npm', 'bin');
    const depsEnv = {
      NPM_CONFIG_PREFIX: join(depsUserDir, 'npm'),
      PIP_TARGET: join(depsUserDir, 'py'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      MAO_DEPS_BIN: depsBin,
    };
    const counts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await executor.handleToolCall('shell', JSON.stringify({
        action: 'exec',
        command: 'echo $PATH',
        session_id: 'sh-deps-idem',
        keep_session: true,
        yield_time_ms: 8000,
      }), envelopeOf(userWorkspace, 11, depsEnv));
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeUndefined();
      counts.push(parsed.output.split(depsBin).length - 1);
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('keepsEnvelopeAvailableToParallelInFlightCalls', async () => {
    // 回归（2026-11-04）：并行工具调用时，先完成的工具不得清掉在途调用仍在读取的 envelope。
    // 旧实现用单一字段 + finally 无条件清空：read_file 这类快工具先完成会把共享 envelope 清掉，
    // 并行中的 shell 调用随后创建/刷新会话时读到 null → depsEnv 丢失（PATH 无 deps bin），
    // 表现为容器内已安装的 CLI 间歇性 `command not found`。
    const base = useTmpDir('mao-exec-parallel-env-');
    const workspaceRoot = join(base, 'workspace');
    const depsUserDir = join(base, 'deps', String(USER_ID));
    const userWorkspace = join(workspaceRoot, String(USER_ID), 'proj');
    mkdirSync(userWorkspace, { recursive: true });
    const probeFile = join(userWorkspace, 'probe.txt');
    writeFileSync(probeFile, 'hello');
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
    }, USER_ID);
    const depsEnv = {
      NPM_CONFIG_PREFIX: join(depsUserDir, 'npm'),
      PIP_TARGET: join(depsUserDir, 'py'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      MAO_DEPS_BIN: join(depsUserDir, 'npm', 'bin'),
    };
    // 同批两次调用：shell 慢（执行链多处 await），read_file 快（同步读文件）。
    // 旧实现中 read_file 的 finally 会清空共享 envelope，shell 随后取 depsEnv 得到 null。
    const [readResult, shellResult] = await Promise.all([
      executor.handleToolCall('read_file', JSON.stringify({ path: probeFile }), envelopeOf(userWorkspace, 11, depsEnv)),
      executor.handleToolCall('shell', JSON.stringify({
        action: 'exec',
        command: 'echo "BIN=[$MAO_DEPS_BIN] PATH=[$PATH]"',
        yield_time_ms: 8000,
      }), envelopeOf(userWorkspace, 11, depsEnv)),
    ]);
    expect(JSON.parse(readResult).content).toBe('hello');
    const parsed = JSON.parse(shellResult);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain(`BIN=[${depsEnv.MAO_DEPS_BIN}]`);
    expect(parsed.output).toContain(`PATH=[${depsEnv.MAO_DEPS_BIN}:`);
  });
});

function otherHome(userHomeDir: string): string {
  return join(userHomeDir, '8');
}
