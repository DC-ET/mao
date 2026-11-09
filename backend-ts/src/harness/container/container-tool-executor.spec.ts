import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerToolExecutor } from './container-tool-executor.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

const USER_ID = 7;

/** ContainerRoots 测试夹具：2026-11-09 起 share 按 Agent 收窄为两条子路径（经验库 + 私有区）。 */
function withShareTrees<T extends { shareDir: string }>(
  roots: T,
  agentId = USER_ID,
): T & { shareExperienceDir: string; shareAgentDir: string } {
  return {
    ...roots,
    shareExperienceDir: join(roots.shareDir, 'agent-experience', String(agentId)),
    shareAgentDir: join(roots.shareDir, 'agents', String(agentId)),
  };
}

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
    maoBaseUrl: null,
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

    const executor = new ContainerToolExecutor(withShareTrees({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir, skillViewsDir: join(base, 'skill-views'), uploadDir: join(base, 'uploads'), shareDir: join(base, 'share') }), USER_ID);

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
    const executor = new ContainerToolExecutor(withShareTrees({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir, skillViewsDir: join(base, 'skill-views'), uploadDir: join(base, 'uploads'), shareDir: join(base, 'share') }), USER_ID);
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

  it('crossMemberReadsGetSpecializedDiagnosticsThroughExecutor', async () => {
    // 接线守护（评审 P2）：identity 由 ContainerToolExecutor 构造时注入 PathSandbox，
    // 若有人删掉那一行，这里读他人 runtime/uploads 会回落通用越界文案、断言失败。
    const base = useTmpDir('mao-exec-identity-');
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userHomeDir = join(base, 'users');
    const userSkillsDir = join(base, 'userskills');
    const uploadDir = join(base, 'uploads');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(runtimeDir, '8', '1607', 'shellOutput'), { recursive: true });
    writeFileSync(join(runtimeDir, '8', '1607', 'shellOutput', 'x.out'), 'foreign');
    mkdirSync(join(uploadDir, '8'), { recursive: true });
    writeFileSync(join(uploadDir, '8', 'gen.png'), 'foreign');
    mkdirSync(join(uploadDir, 'releases'), { recursive: true });
    writeFileSync(join(uploadDir, 'releases', 'latest.yml'), 'release');
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot, runtimeDir, userHomeDir, userSkillsDir,
      skillViewsDir: join(base, 'skill-views'), uploadDir, shareDir: join(base, 'share') }), USER_ID);
    const env = envelopeOf(userWorkspace);

    const runtimeRead = await executor.handleToolCall(
      'read_file', JSON.stringify({ path: join(runtimeDir, '8', '1607', 'shellOutput', 'x.out') }), env,
    );
    expect(JSON.parse(runtimeRead).error).toContain('其他用户的会话运行目录');
    const uploadRead = await executor.handleToolCall(
      'read_file', JSON.stringify({ path: join(uploadDir, '8', 'gen.png') }), env,
    );
    expect(JSON.parse(uploadRead).error).toContain('其他成员的产物目录');
    // 非身份目录（releases）回落通用越界文案，不误报为「其他成员」
    const genericRead = await executor.handleToolCall(
      'read_file', JSON.stringify({ path: join(uploadDir, 'releases', 'latest.yml') }), env,
    );
    const genericError = JSON.parse(genericRead).error as string;
    expect(genericError).toBeDefined();
    expect(genericError).not.toContain('其他成员');
  });

  it('readBytesEnforcesSandboxAndSizeLimit', () => {
    const base = useTmpDir('mao-exec-bytes-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    writeFileSync(join(userWorkspace, 'pic.txt'), 'A'.repeat(100));
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir,
      shareDir,
    }), USER_ID);
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

  it('readsFileUnderOwnShareTreesAndRejectsCrossAgent', async () => {
    // 2026-11-09 形态 C：沙箱允许根 = 本 Agent 经验库 + 私有区两条子路径。
    // 其他 Agent 目录 / share 根公共文件在容器内既无挂载、也无允许根（双层拒绝）。
    // 本 Agent 子树内指向外部的 symlink 仍被 strict resolve + realpath 逃逸检测拒绝。
    const base = useTmpDir('mao-exec-share-');
    const workspaceRoot = join(base, 'workspace');
    const shareDir = join(base, 'share');
    const experienceAgentDir = join(shareDir, 'agent-experience', String(USER_ID));
    const agentPrivateDir = join(shareDir, 'agents', String(USER_ID));
    const otherAgentDir = join(shareDir, 'agent-experience', '6');
    const userWorkspace = join(workspaceRoot, '7');
    const outside = join(base, 'outside');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(experienceAgentDir, { recursive: true });
    mkdirSync(agentPrivateDir, { recursive: true });
    mkdirSync(otherAgentDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(experienceAgentDir, 'doc.md'), 'shared-content');
    writeFileSync(join(agentPrivateDir, 'tool.txt'), 'private-content');
    writeFileSync(join(otherAgentDir, 'doc.md'), 'other-agent');
    writeFileSync(join(shareDir, 'public.txt'), 'platform-content');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(experienceAgentDir, 'escape.txt'));
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir,
    }), USER_ID);
    const env = envelopeOf(userWorkspace);

    // 本 Agent 经验库与私有区按绝对路径可读写
    const own = await executor.handleToolCall('read_file', JSON.stringify({ path: join(experienceAgentDir, 'doc.md') }), env);
    expect(JSON.parse(own).content).toBe('shared-content');
    const ownPrivate = await executor.handleToolCall('read_file', JSON.stringify({ path: join(agentPrivateDir, 'tool.txt') }), env);
    expect(JSON.parse(ownPrivate).content).toBe('private-content');
    // read_bytes 桥同口径
    expect(executor.handleReadBytes(join(experienceAgentDir, 'doc.md'), 1000, env).ok).toBe(true);
    expect(executor.handleReadBytes(join(agentPrivateDir, 'tool.txt'), 1000, env).ok).toBe(true);
    // 跨 Agent 目录：不在允许根内 → 拒绝
    const otherAgent = await executor.handleToolCall('read_file', JSON.stringify({ path: join(otherAgentDir, 'doc.md') }), env);
    expect(JSON.parse(otherAgent).error).toBeDefined();
    // share 根公共文件：公共投放区已取消 → 拒绝
    const publicFile = await executor.handleToolCall('read_file', JSON.stringify({ path: join(shareDir, 'public.txt') }), env);
    expect(JSON.parse(publicFile).error).toBeDefined();
    expect(executor.handleReadBytes(join(shareDir, 'public.txt'), 1000, env).ok).toBe(false);
    // 本 Agent 子树内指向外部的 symlink 被逃逸检测拒绝
    const escape = await executor.handleToolCall('read_file', JSON.stringify({ path: join(experienceAgentDir, 'escape.txt') }), env);
    expect(JSON.parse(escape).error).toBeDefined();
  });

  it('readsSessionSkillSymlinkUnderSkillViewsRoot', async () => {
    // 技术方案 2026-11-03 §7.1（2026-11-07 按 agent 收窄）：会话技能是 {runtimeDir}/{u}/{s}/skills/{name} ->
    // {skillViewsDir}/{u}/{a}/{name} 的符号链接（SkillSyncService 指向用户+Agent 级只读视图），
    // 视图按用户登记为允许根后经 strict 校验可读；指向视图之外的链接仍被拒绝。
    const base = useTmpDir('mao-exec-skills-');
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userWorkspace = join(workspaceRoot, '7');
    // 2026-11-07：MAO_SKILL_VIEWS_DIR 注入值即当前 (user, agent) 的视图目录，
    // 允许根 = 该目录；其他 Agent 的视图目录天然在允许根之外
    const skillViewsDir = join(base, 'skill-views', '7', '5');
    const viewDir = join(skillViewsDir, 'bigdata-cli');
    const otherViewDir = join(base, 'skill-views', '8', '5', 'bigdata-cli');
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir,
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir,
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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

  it('shellWorkdirUnderShareAgentTreeIsAllowed', async () => {
    // CHANGELOG（2026-11-09）：shell workdir 对本 Agent share 子树（私有区/经验库）可达
    // （与 read_file 同一 resolveLenient 代码路径）。share 整根不再放行。
    const base = useTmpDir('mao-exec-share-shell-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const shareDir = join(base, 'share');
    const shareSub = join(shareDir, 'agents', String(USER_ID), 'docs');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(shareSub, { recursive: true });
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir,
    }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
    const executor = new ContainerToolExecutor(withShareTrees({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share') }), USER_ID);
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
