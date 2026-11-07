import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerMountPlanner, MountPlanError } from './container-mount-planner.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function roots(base: string) {
  return {
    userHomeDir: join(base, 'users'),
    runtimeDir: join(base, 'runtime'),
    workspaceRoot: join(base, 'workspace'),
    depsDir: join(base, 'deps'),
    userSkillsDir: join(base, 'userskills'),
    channelDir: join(base, 'runtime', 'channels'),
    distDir: join(base, 'mao', 'backend-ts', 'dist'),
    skillsDir: join(base, 'mao', 'data', 'skills'),
    skillViewsDir: join(base, 'mao', 'data', 'skill-views'),
    uploadDir: join(base, 'uploads'),
    tmpDir: join(base, 'tmp'),
    shareDir: join(base, 'share'),
  };
}

describe('container mount planner', () => {
  it('plansPerUserMountsWithUserIdSegments', () => {
    const base = useTmpDir('mao-mount-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(7, 5);
    // 除共享目录根（团队经验库 rw，2026-10-24）外，每条 rw 挂载都只含 user=7 的路径
    for (const m of mounts.filter((x) => x.mode === 'rw' && x.purpose !== 'share')) {
      expect(m.hostPath).toContain('/7');
      expect(m.hostPath.startsWith(base)).toBe(true);
    }
    // dist 只读
    expect(mounts.find((m) => m.purpose === 'dist')?.mode).toBe('ro');
    // 技能视图（2026-11-03）：按用户只读挂载；源目录（skills）不再挂载
    const skillViews = mounts.find((m) => m.purpose === 'skillViews');
    expect(skillViews?.mode).toBe('ro');
    expect(skillViews?.hostPath).toBe(join(base, 'mao', 'data', 'skill-views', '7', '5'));
    expect(skillViews?.containerPath).toBe(skillViews?.hostPath);
    expect(mounts.find((m) => m.purpose === 'skills')).toBeUndefined();
    expect(mounts.some((m) => m.hostPath === join(base, 'mao', 'data', 'skills'))).toBe(false);
    // 除每用户 /tmp 的路径映射外，容器内路径与宿主机逐字节一致（决策 15）
    for (const m of mounts.filter((x) => x.purpose !== 'tmp')) expect(m.containerPath).toBe(m.hostPath);
    // /tmp 持久化：宿主 {tmpDir}/{userId} -> 容器 /tmp，rw
    const tmp = mounts.find((m) => m.purpose === 'tmp');
    expect(tmp?.hostPath).toBe(join(base, 'tmp', '7'));
    expect(tmp?.containerPath).toBe('/tmp');
    expect(tmp?.mode).toBe('rw');
    expect(statSync(tmp!.hostPath).mode & 0o7777).toBe(0o1777);
    // 不包含其他用户尾段
    expect(JSON.stringify(mounts)).not.toContain('/users/8');
    expect(JSON.stringify(mounts)).not.toContain('/runtime/8');
  });

  it('toleratesMissingSkillViewsDir', () => {
    // ro 项不强制创建：视图由后端首次物化生成（docker -v 对缺失源自动建空目录兜底）
    const base = useTmpDir('mao-mount-views-miss-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner({ ...roots(base), skillViewsDir: join(base, 'no-such-views') });
    const mounts = planner.plan(7, 5);
    expect(mounts.find((m) => m.purpose === 'skillViews')?.hostPath).toBe(join(base, 'no-such-views', '7', '5'));
  });

  it('mountsUploadsPerUserAndRejectsFlatRoot', () => {
    // 图片产物按用户隔离：{uploadDir}/{userId} 同名挂载，容器内路径与宿主机一致
    const base = useTmpDir('mao-mount-up-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const uploads = planner.plan(7, 5).find((m) => m.purpose === 'uploads');
    expect(uploads).toBeDefined();
    expect(uploads!.hostPath).toBe(join(base, 'uploads', '7'));
    expect(uploads!.containerPath).toBe(uploads!.hostPath);
    expect(uploads!.mode).toBe('rw');
    // 平坦 uploads 根（含所有用户产物）不得挂进容器
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'uploads'), containerPath: join(base, 'uploads'), mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(/must contain/);
  });

  it('fingerprintTracksStandardMountPlan', () => {
    // 挂载清单在 docker run 时定型：指纹漂移是既有容器重建的唯一触发条件
    const base = useTmpDir('mao-mount-fp-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const fp = planner.standardMountsFingerprint(7, 5);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // 同一计划稳定；动态会话工作区不进指纹
    expect(planner.standardMountsFingerprint(7, 5)).toBe(fp);
    const feishu = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(feishu, { recursive: true });
    expect(planner.standardMountsFingerprint(7, 5)).toBe(fp);
    // roots 变更（planner 升级新增/移动挂载）→ 指纹变化
    const moved = new ContainerMountPlanner({ ...roots(base), uploadDir: join(base, 'uploads2') });
    expect(moved.standardMountsFingerprint(7, 5)).not.toBe(fp);
    // share 配置变化同样进指纹（上线后既有容器指纹漂移即回收重建补齐挂载）
    const movedShare = new ContainerMountPlanner({ ...roots(base), shareDir: join(base, 'share2') });
    expect(movedShare.standardMountsFingerprint(7, 5)).not.toBe(fp);
    // 技能视图根变化进指纹（2026-11-03：skills 挂载 → skillViews ro 挂载，存量容器自动重建一次）
    const movedViews = new ContainerMountPlanner({ ...roots(base), skillViewsDir: join(base, 'views2') });
    expect(movedViews.standardMountsFingerprint(7, 5)).not.toBe(fp);
    // 不同用户的标准计划不同（uid 段进清单）
    expect(planner.standardMountsFingerprint(8, 5)).not.toBe(fp);
  });

  it('mountsShareDirReadWrite', () => {
    // 团队经验库方案 2026-10-24 D10：share 由 ro 改 rw（agent-experience/ 子目录需容器内写入）。
    // 容器内路径与宿主机逐字节一致；防误删从 ro 挂载退化为信任 + 宿主快照兜底。
    // mode 参与指纹（fingerprintTracksStandardMountPlan 的序列化含 mode），ro→rw 上线即触发存量容器重建。
    const base = useTmpDir('mao-mount-share-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const share = planner.plan(7, 5).find((m) => m.purpose === 'share');
    expect(share).toBeDefined();
    expect(share!.mode).toBe('rw');
    expect(share!.hostPath).toBe(join(base, 'share', 'agent-experience', '5'));
    expect(share!.containerPath).toBe(share!.hostPath);
    // 同一 roots 把 share 拨回 ro 的指纹必须不同：ro→rw 变更可被指纹感知
    const roVariant = planner.plan(7, 5).map((m) => (m.purpose === 'share' ? { ...m, mode: 'ro' as const } : m));
    expect(planner.fingerprintOf(roVariant)).not.toBe(planner.standardMountsFingerprint(7, 5));
  });

  it('shareDirMissingIsTolerated', () => {
    // ro 项不强制创建：shareDir 不存在时 plan 不抛错（docker -v 对缺失源自动建空目录，
    // 叠加后端启动 mkdirSync 兜底，双保险）
    const base = useTmpDir('mao-mount-share-miss-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner({ ...roots(base), shareDir: join(base, 'no-such-share') });
    const mounts = planner.plan(7, 5);
    expect(mounts.find((m) => m.purpose === 'share')?.hostPath).toBe(join(base, 'no-such-share', 'agent-experience', '5'));
  });

  it('rejectsShareDirAsParentOfRoot', () => {
    // shareDir 误配为某登记根的父目录（如 /opt/mao-data）→ fail-fast。
    // 评审修订 §4.4 后，skillViewsDir 位于 shareDir 之下的场景命中断言专用报错（互不包含）。
    const base = useTmpDir('mao-mount-share-parent-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner({ ...roots(base), shareDir: base });
    expect(() => planner.plan(7, 5)).toThrow(/must not be or under shareDir|is a parent of registered root/);
  });

  it('rejectsShareDirContainingSkillViewsDir', () => {
    // 评审修订 §4.4：skillViewsDir 与 shareDir 互不包含——shareDir 为视图根父目录时，
    // 视图根会同时被 share 整根 rw 覆盖、又被 ro 精确挂载，产生挂载语义歧义
    const base = useTmpDir('mao-mount-share-views-parent-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const r = roots(base);
    const planner = new ContainerMountPlanner({ ...r, shareDir: join(base, 'share'), skillViewsDir: join(base, 'share', 'views') });
    expect(() => planner.plan(7, 5)).toThrow(/must not be or under shareDir/);
  });

  it('rejectsShareDirEqualToPerUserRoot', () => {
    // 共享目录方案 §4.1 等式盲区：shareDir 等于某个按用户收窄的登记根、或位于其下，
    // 现有 assertSafe 规则全部放行（容器路径不重复、父目录防护对等式 continue），
    // 会把整棵每用户数据 ro 挂进所有容器——必须 fail-fast
    const base = useTmpDir('mao-mount-share-eq-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner({ ...roots(base), shareDir: join(base, 'workspace') });
    expect(() => planner.plan(7, 5)).toThrow(/must not be or under per-user data root/);
    // 位于每用户根之下（如某用户的工作区子目录）同样拒绝
    const underPlanner = new ContainerMountPlanner({ ...roots(base), shareDir: join(base, 'workspace', '7') });
    expect(() => underPlanner.plan(7, 5)).toThrow(/must not be or under per-user data root/);
  });

  it('rejectsShareDirEqualToRootFilesystem', () => {
    // 回归（round-02 review Bug 2）：shareDir='/' 时旧父目录防护的
    // startsWith(host + sep) 拼出 '//' 永不匹配，防护静默失效——整棵宿主文件系统
    // （/etc/shadow、他人工作区）会被 ro 挂进所有容器。path.relative 包含判定修复
    const base = useTmpDir('mao-mount-share-root-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner({ ...roots(base), shareDir: '/' });
    expect(() => planner.plan(7, 5)).toThrow(/is a parent of registered root|must be exactly|not under any registered data root/);
  });

  it('rejectsShareDirEqualToDistOrSkills', () => {
    // 设计 §4.1：shareDir 等于 distDir 时容器内路径重复（两条 ro/rw 条目指向同一容器路径），
    // assertSafe 重复容器路径检测拒绝；技能根场景改由独立性检查显式拒绝（skills 挂载移除后
    // 不再有重复容器路径兜底，见下个用例）
    const base = useTmpDir('mao-mount-share-dup-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const r = roots(base);
    expect(() => new ContainerMountPlanner({ ...r, shareDir: r.distDir }).plan(7, 5))
      .toThrow(/must not be or under per-user data root/);
    expect(() => new ContainerMountPlanner({ ...r, shareDir: r.skillsDir }).plan(7, 5))
      .toThrow(/must not be or under per-user data root/);
  });

  it('rejectsShareDirOverSkillRoots', () => {
    // 技能视图根含全部用户子目录：等值/位于其下会把所有用户的授权技能整棵挂进每个容器；
    // 技能源等值则把「永不进容器」的共享源重新挂进去——两者都必须 fail-fast
    const base = useTmpDir('mao-mount-share-skills-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const r = roots(base);
    expect(() => new ContainerMountPlanner({ ...r, shareDir: r.skillViewsDir }).plan(7, 5))
      .toThrow(/must not be or under per-user data root/);
    expect(() => new ContainerMountPlanner({ ...r, shareDir: join(r.skillViewsDir, '7') }).plan(7, 5))
      .toThrow(/must not be or under per-user data root/);
  });

  it('rejectsParentDirectoryMounts', () => {
    const base = useTmpDir('mao-mount-p-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    // 把数据根整体挂进容器（等于挂了全部用户）必须拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users'), containerPath: join(base, 'users'), mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(MountPlanError);
    // /opt/mao-data 父目录场景
    expect(() => planner.assertSafe([
      { hostPath: base, containerPath: base, mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(MountPlanError);
  });

  it('rejectsRwMountsWithoutUserSegment', () => {
    const base = useTmpDir('mao-mount-u-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', 'shared'), containerPath: join(base, 'users', 'shared'), mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(/must contain/);
  });

  it('skillsRootNoLongerHasRwException', () => {
    // 2026-11-03 技术方案 §4.4：删除 isPlatformSkillsRoot 例外——不再存在全局可写共享技能根，
    // 技能源（skillsDir）既不能被 rw 挂进容器，也不产生任何挂载
    const base = useTmpDir('mao-mount-skills-rw-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const skillsDir = join(base, 'mao', 'data', 'skills');
    expect(() => planner.assertSafe([
      { hostPath: skillsDir, containerPath: skillsDir, mode: 'rw', purpose: 'skills' },
    ], 7, 5)).toThrow(/must contain/);
    // ro 挂载技能源也不再出现在标准清单里（源对容器完全不可见）
    expect(planner.plan(7, 5).some((m) => m.hostPath === skillsDir)).toBe(false);
  });

  it('rejectsSymlinkEscapeAndForeignUserPaths', () => {
    const base = useTmpDir('mao-mount-s-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'x'), 'x');
    const planner = new ContainerMountPlanner(roots(base));
    // 用户家目录下的符号链接指向登记根之外
    const home = join(base, 'users', '7');
    mkdirSync(home, { recursive: true });
    symlinkSync(outside, join(home, 'escape'));
    expect(() => planner.assertSafe([
      { hostPath: join(home, 'escape'), containerPath: join(home, 'escape'), mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(/symlink|registered root/);
    // 其他用户的路径（userId 段不匹配）
    const other = join(base, 'users', '8');
    mkdirSync(other, { recursive: true });
    expect(() => planner.assertSafe([
      { hostPath: other, containerPath: other, mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(MountPlanError);
  });

  it('rejectsPathTranslationAndDuplicates', () => {
    const base = useTmpDir('mao-mount-t-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    // 容器内路径改写（决策 15 不做翻译）必须拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', '7'), containerPath: '/home/mao', mode: 'rw', purpose: 'bad' },
    ], 7, 5)).toThrow(/must equal host path/);
    // 重复容器路径
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', '7'), containerPath: join(base, 'users', '7'), mode: 'rw', purpose: 'a' },
      { hostPath: join(base, 'users', '7'), containerPath: join(base, 'users', '7'), mode: 'rw', purpose: 'b' },
    ], 7, 5)).toThrow(/duplicate/);
  });

  it('auditLogDoesNotThrowForValidPlan', () => {
    const base = useTmpDir('mao-mount-a-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(9, 5);
    expect(() => planner.auditLog(9, 5, mounts)).not.toThrow();
    // 审计口径与挂载表一致：每行含 purpose/mode（结构断言）
    expect(mounts.length).toBeGreaterThanOrEqual(8);
    expect(mounts.every((m) => m.mode === 'rw' || m.mode === 'ro')).toBe(true);
  });

  it('mountsChannelSessionWorkspacesPassedAsExtras', () => {
    // N-2 回归：飞书/钉钉通道会话工作区（越出每用户根）按调用方传入的清单附加挂载
    const base = useTmpDir('mao-mount-ch-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const feishu = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    const dingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-7');
    mkdirSync(feishu, { recursive: true });
    mkdirSync(dingtalk, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(7, 5, [feishu, dingtalk]);
    for (const ws of [feishu, dingtalk]) {
      const mount = mounts.find((m) => m.hostPath === ws);
      expect(mount, `${ws} 应被附加挂载`).toBeDefined();
      expect(mount!.mode).toBe('rw');
      expect(mount!.containerPath).toBe(ws);
      expect(mount!.purpose).toBe('sessionWorkspace');
    }
    // 重复传入只挂一份
    expect(planner.plan(7, 5, [feishu, feishu]).filter((m) => m.hostPath === feishu).length).toBe(1);
    // 已在标准清单内的每用户根工作区不重复附加
    const webWs = join(base, 'workspace', '7', 'web');
    mkdirSync(webWs, { recursive: true });
    expect(planner.plan(7, 5, [webWs]).filter((m) => m.hostPath === webWs).length).toBe(0);
  });

  it('rejectsChannelRootAndAccountLevelExtras', () => {
    // N-2 安全边界：挂整个通道根或账号目录会把其他用户的私聊工作区带进容器，一律拒绝
    const base = useTmpDir('mao-mount-ch-bad-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const channelRoot = join(base, 'workspace', 'feishu-chat');
    mkdirSync(channelRoot, { recursive: true });
    const accountDir = join(channelRoot, 'bot-1');
    mkdirSync(accountDir, { recursive: true });
    expect(() => planner.plan(7, 5, [channelRoot])).toThrow(/concrete \{account\}\/\{leaf\}/);
    expect(() => planner.plan(7, 5, [accountDir])).toThrow(/concrete \{account\}\/\{leaf\}/);
    // 非通道根路径（其他数据根/系统目录）不得作为附加挂载
    expect(() => planner.plan(7, 5, [join(base, 'users', '8')])).toThrow(/channel workspace root/);
    expect(() => planner.plan(7, 5, ['/etc'])).toThrow(/channel workspace root/);
  });

  it('rejectsPrivateChannelWorkspaceOfAnotherUser', () => {
    // N-5 归属校验（挂载边界纵深防御）：session.workspace 用户可控，私聊工作区
    // private-{userId} 只允许挂进本人容器，否则可把他人飞书私聊目录以 rw 挂进本人容器
    const base = useTmpDir('mao-mount-own-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const otherPrivate = join(base, 'workspace', 'feishu-chat', 'bot-1', 'private-8');
    mkdirSync(otherPrivate, { recursive: true });
    writeFileSync(join(otherPrivate, 'secret.txt'), 'foreign');
    expect(() => planner.plan(7, 5, [otherPrivate])).toThrow(/does not belong to user 7/);
    // 钉钉侧同规则
    const otherDingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-9');
    mkdirSync(otherDingtalk, { recursive: true });
    expect(() => planner.plan(7, 5, [otherDingtalk])).toThrow(/does not belong to user 7/);
    // 本人的私聊工作区照常挂载
    const ownPrivate = join(base, 'workspace', 'feishu-chat', 'bot-1', 'private-7');
    mkdirSync(ownPrivate, { recursive: true });
    const mount = planner.plan(7, 5, [ownPrivate]).find((m) => m.hostPath === ownPrivate);
    expect(mount?.mode).toBe('rw');
    expect(mount?.purpose).toBe('sessionWorkspace');
    const ownDingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-7');
    mkdirSync(ownDingtalk, { recursive: true });
    expect(planner.plan(7, 5, [ownDingtalk]).some((m) => m.hostPath === ownDingtalk)).toBe(true);
    // 群聊工作区（leaf 为 chatId）按设计由同群多用户会话共享，不按 userId 拒绝
    const groupWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(groupWs, { recursive: true });
    expect(planner.plan(7, 5, [groupWs]).some((m) => m.hostPath === groupWs)).toBe(true);
  });

  it('mountsAgentScopedViewsExperienceAndChannel', () => {
    // 2026-11-07 复合容器方案 §3.2：skillViews/share/channel 三条按 {root}/{userId}/{agentId} 收窄
    const base = useTmpDir('mao-mount-agent-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(7, 5);
    expect(mounts.find((m) => m.purpose === 'skillViews')?.hostPath).toBe(join(base, 'mao', 'data', 'skill-views', '7', '5'));
    expect(mounts.find((m) => m.purpose === 'share')?.hostPath).toBe(join(base, 'share', 'agent-experience', '5'));
    expect(mounts.find((m) => m.purpose === 'channel')?.hostPath).toBe(join(base, 'runtime', 'channels', '7', '5'));
    // 不同 agent 的标准清单不同（agentId 段进指纹）
    expect(planner.standardMountsFingerprint(7, 6)).not.toBe(planner.standardMountsFingerprint(7, 5));
  });

  it('rejectsMountingOtherAgentsExperienceOrWholeShareRoot', () => {
    // agent 段校验：share 只允许恰为 {shareDir}/agent-experience/{agentId}——
    // 挂整根 / 其他 Agent 子目录 / 上级目录一律拒绝（容器级 Agent 隔离的安全边界）
    const base = useTmpDir('mao-mount-agent-bad-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const experienceAgentDir = join(base, 'share', 'agent-experience', '5');
    // 挂 share 整根（旧形态）→ 拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'share'), containerPath: join(base, 'share'), mode: 'rw', purpose: 'share' },
    ], 7, 5)).toThrow(/must be exactly/);
    // 挂其他 Agent 的经验库 → 拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'share', 'agent-experience', '6'), containerPath: join(base, 'share', 'agent-experience', '6'), mode: 'rw', purpose: 'share' },
    ], 7, 5)).toThrow(/must be exactly/);
    // 挂经验根（agent-experience/）→ 拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'share', 'agent-experience'), containerPath: join(base, 'share', 'agent-experience'), mode: 'rw', purpose: 'share' },
    ], 7, 5)).toThrow(/must be exactly/);
    // 恰为本人经验子目录 → 放行（无需 userId 段，agent 维度即隔离边界）
    expect(() => planner.assertSafe([
      { hostPath: experienceAgentDir, containerPath: experienceAgentDir, mode: 'rw', purpose: 'share' },
    ], 7, 5)).not.toThrow();
    // skillViews / channel 挂到用户根（缺 agentId 段）→ 拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'mao', 'data', 'skill-views', '7'), containerPath: join(base, 'mao', 'data', 'skill-views', '7'), mode: 'ro', purpose: 'skillViews' },
    ], 7, 5)).toThrow(/must be exactly/);
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'runtime', 'channels', '7'), containerPath: join(base, 'runtime', 'channels', '7'), mode: 'rw', purpose: 'channel' },
    ], 7, 5)).toThrow(/must be exactly/);
  });
});
