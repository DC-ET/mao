import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  };
}

describe('container mount planner', () => {
  it('plansPerUserMountsWithUserIdSegments', () => {
    const base = useTmpDir('mao-mount-');
    for (const dir of Object.values(roots(base))) mkdirSync(dir, { recursive: true });
    const planner = new ContainerMountPlanner(roots(base));
    const mounts = planner.plan(7);
    // 每条 rw 挂载都只含 user=7 的路径
    for (const m of mounts.filter((x) => x.mode === 'rw')) {
      expect(m.hostPath).toContain('/7');
      expect(m.hostPath.startsWith(base)).toBe(true);
    }
    // dist 与共享技能只读
    expect(mounts.find((m) => m.purpose === 'dist')?.mode).toBe('ro');
    expect(mounts.find((m) => m.purpose === 'skills')?.mode).toBe('ro');
    // 容器内路径与宿主机逐字节一致（决策 15）
    for (const m of mounts) expect(m.containerPath).toBe(m.hostPath);
    // 不包含其他用户尾段
    expect(JSON.stringify(mounts)).not.toContain('/users/8');
    expect(JSON.stringify(mounts)).not.toContain('/runtime/8');
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
    const otherDingtalk = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'private-9');
    mkdirSync(otherDingtalk, { recursive: true });
    expect(() => planner.plan(7, [otherDingtalk])).toThrow(/does not belong to user 7/);
    // 本人的私聊工作区照常挂载
    const ownPrivate = join(base, 'workspace', 'feishu-chat', 'bot-1', 'private-7');
    mkdirSync(ownPrivate, { recursive: true });
    const mount = planner.plan(7, [ownPrivate]).find((m) => m.hostPath === ownPrivate);
    expect(mount?.mode).toBe('rw');
    expect(mount?.purpose).toBe('sessionWorkspace');
    // 群聊工作区（leaf 为 chatId）按设计由同群多用户会话共享，不按 userId 拒绝
    const groupWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(groupWs, { recursive: true });
    expect(planner.plan(7, [groupWs]).some((m) => m.hostPath === groupWs)).toBe(true);
  });
});
