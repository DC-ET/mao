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
    uploadDir: join(base, 'uploads'),
    tmpDir: join(base, 'tmp'),
  };
}

describe('container mount planner', () => {
  it('plansPerUserMountsWithUserIdSegments', () => {
    const base = useTmpDir('mao-mount-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(7);
    // 除平台技能根外，每条 rw 挂载都只含 user=7 的路径
    for (const m of mounts.filter((x) => x.mode === 'rw' && x.purpose !== 'skills')) {
      expect(m.hostPath).toContain('/7');
      expect(m.hostPath.startsWith(base)).toBe(true);
    }
    // dist 只读；平台技能根按产品要求可写
    expect(mounts.find((m) => m.purpose === 'dist')?.mode).toBe('ro');
    expect(mounts.find((m) => m.purpose === 'skills')?.mode).toBe('rw');
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

  it('mountsUploadsPerUserAndRejectsFlatRoot', () => {
    // 图片产物按用户隔离：{uploadDir}/{userId} 同名挂载，容器内路径与宿主机一致
    const base = useTmpDir('mao-mount-up-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const uploads = planner.plan(7).find((m) => m.purpose === 'uploads');
    expect(uploads).toBeDefined();
    expect(uploads!.hostPath).toBe(join(base, 'uploads', '7'));
    expect(uploads!.containerPath).toBe(uploads!.hostPath);
    expect(uploads!.mode).toBe('rw');
    // 平坦 uploads 根（含所有用户产物）不得挂进容器
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'uploads'), containerPath: join(base, 'uploads'), mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(/must contain/);
  });

  it('fingerprintTracksStandardMountPlan', () => {
    // 挂载清单在 docker run 时定型：指纹漂移是既有容器重建的唯一触发条件
    const base = useTmpDir('mao-mount-fp-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const fp = planner.standardMountsFingerprint(7);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // 同一计划稳定；动态会话工作区不进指纹
    expect(planner.standardMountsFingerprint(7)).toBe(fp);
    const feishu = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(feishu, { recursive: true });
    expect(planner.standardMountsFingerprint(7)).toBe(fp);
    // roots 变更（planner 升级新增/移动挂载）→ 指纹变化
    const moved = new ContainerMountPlanner({ ...roots(base), uploadDir: join(base, 'uploads2') });
    expect(moved.standardMountsFingerprint(7)).not.toBe(fp);
    // 不同用户的标准计划不同（uid 段进清单）
    expect(planner.standardMountsFingerprint(8)).not.toBe(fp);
  });

  it('rejectsParentDirectoryMounts', () => {
    const base = useTmpDir('mao-mount-p-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    // 把数据根整体挂进容器（等于挂了全部用户）必须拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users'), containerPath: join(base, 'users'), mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(MountPlanError);
    // /opt/mao-data 父目录场景
    expect(() => planner.assertSafe([
      { hostPath: base, containerPath: base, mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(MountPlanError);
  });

  it('rejectsRwMountsWithoutUserSegment', () => {
    const base = useTmpDir('mao-mount-u-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', 'shared'), containerPath: join(base, 'users', 'shared'), mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(/must contain/);
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
    ], 7)).toThrow(/symlink|registered root/);
    // 其他用户的路径（userId 段不匹配）
    const other = join(base, 'users', '8');
    mkdirSync(other, { recursive: true });
    expect(() => planner.assertSafe([
      { hostPath: other, containerPath: other, mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(MountPlanError);
  });

  it('rejectsPathTranslationAndDuplicates', () => {
    const base = useTmpDir('mao-mount-t-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    // 容器内路径改写（决策 15 不做翻译）必须拒绝
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', '7'), containerPath: '/home/mao', mode: 'rw', purpose: 'bad' },
    ], 7)).toThrow(/must equal host path/);
    // 重复容器路径
    expect(() => planner.assertSafe([
      { hostPath: join(base, 'users', '7'), containerPath: join(base, 'users', '7'), mode: 'rw', purpose: 'a' },
      { hostPath: join(base, 'users', '7'), containerPath: join(base, 'users', '7'), mode: 'rw', purpose: 'b' },
    ], 7)).toThrow(/duplicate/);
  });

  it('auditLogDoesNotThrowForValidPlan', () => {
    const base = useTmpDir('mao-mount-a-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(9);
    expect(() => planner.auditLog(9, mounts)).not.toThrow();
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
    const mounts = planner.plan(7, [feishu, dingtalk]);
    for (const ws of [feishu, dingtalk]) {
      const mount = mounts.find((m) => m.hostPath === ws);
      expect(mount, `${ws} 应被附加挂载`).toBeDefined();
      expect(mount!.mode).toBe('rw');
      expect(mount!.containerPath).toBe(ws);
      expect(mount!.purpose).toBe('sessionWorkspace');
    }
    // 重复传入只挂一份
    expect(planner.plan(7, [feishu, feishu]).filter((m) => m.hostPath === feishu).length).toBe(1);
    // 已在标准清单内的每用户根工作区不重复附加
    const webWs = join(base, 'workspace', '7', 'web');
    mkdirSync(webWs, { recursive: true });
    expect(planner.plan(7, [webWs]).filter((m) => m.hostPath === webWs).length).toBe(0);
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
    expect(() => planner.plan(7, [channelRoot])).toThrow(/concrete \{account\}\/\{leaf\}/);
    expect(() => planner.plan(7, [accountDir])).toThrow(/concrete \{account\}\/\{leaf\}/);
    // 非通道根路径（其他数据根/系统目录）不得作为附加挂载
    expect(() => planner.plan(7, [join(base, 'users', '8')])).toThrow(/channel workspace root/);
    expect(() => planner.plan(7, ['/etc'])).toThrow(/channel workspace root/);
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
    expect(() => planner.plan(7, [otherPrivate])).toThrow(/does not belong to user 7/);
    // 钉钉侧同规则
    const otherDingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-9');
    mkdirSync(otherDingtalk, { recursive: true });
    expect(() => planner.plan(7, [otherDingtalk])).toThrow(/does not belong to user 7/);
    // 本人的私聊工作区照常挂载
    const ownPrivate = join(base, 'workspace', 'feishu-chat', 'bot-1', 'private-7');
    mkdirSync(ownPrivate, { recursive: true });
    const mount = planner.plan(7, [ownPrivate]).find((m) => m.hostPath === ownPrivate);
    expect(mount?.mode).toBe('rw');
    expect(mount?.purpose).toBe('sessionWorkspace');
    const ownDingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-7');
    mkdirSync(ownDingtalk, { recursive: true });
    expect(planner.plan(7, [ownDingtalk]).some((m) => m.hostPath === ownDingtalk)).toBe(true);
    // 群聊工作区（leaf 为 chatId）按设计由同群多用户会话共享，不按 userId 拒绝
    const groupWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(groupWs, { recursive: true });
    expect(planner.plan(7, [groupWs]).some((m) => m.hostPath === groupWs)).toBe(true);
  });
});
