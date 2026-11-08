import { describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSkillViewCompatLinks } from './runtime-agent.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

/**
 * 技能视图兼容链接回归（2026-11-08 线上回归）：
 * deps/{u}/npm 里更早安装的 npm 全局 CLI 软链相对指向 {skillViewsDir}/{u}/{skillName}
 * （历史口径）；0.0.473 视图改为按 (user, agent) 物化、容器只挂 {u}/{a} 后，容器内
 * 该路径不存在 → dama-cli / access-cli 等全部断链。容器启动时补
 * {skillName} -> {a}/{skillName} 相对链接恢复解析（仅补缺失，不覆盖既有条目）。
 */
describe('prepareSkillViewCompatLinks', () => {
  it('为当前 agent 视图补历史路径链接（相对链接，可解析到视图目录）', () => {
    const root = useTmpDir('mao-skill-view-links-');
    const agentViewRoot = join(root, '5', '1');
    mkdirSync(join(agentViewRoot, 'dama-cli'), { recursive: true });
    mkdirSync(join(agentViewRoot, 'access-cli'), { recursive: true });

    expect(prepareSkillViewCompatLinks(agentViewRoot)).toBe(2);

    expect(lstatSync(join(root, '5', 'dama-cli')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '5', 'dama-cli'))).toBe(join('1', 'dama-cli'));
    // 相对链接可解析（statSync 跟随链接），目标即视图内真实目录
    expect(statSync(join(root, '5', 'dama-cli')).isDirectory()).toBe(true);
    expect(realpathSync(join(root, '5', 'access-cli'))).toBe(realpathSync(join(agentViewRoot, 'access-cli')));
  });

  it('幂等：重复执行不再创建（容器重启后重跑安全）', () => {
    const root = useTmpDir('mao-skill-view-links-');
    const agentViewRoot = join(root, '5', '1');
    mkdirSync(join(agentViewRoot, 'dama-cli'), { recursive: true });

    expect(prepareSkillViewCompatLinks(agentViewRoot)).toBe(1);
    expect(prepareSkillViewCompatLinks(agentViewRoot)).toBe(0);
  });

  it('不覆盖既有条目（历史副本残留 / 其它 agent 已建链接）', () => {
    const root = useTmpDir('mao-skill-view-links-');
    const agentViewRoot = join(root, '5', '1');
    mkdirSync(join(agentViewRoot, 'dama-cli'), { recursive: true });
    const legacy = join(root, '5', 'dama-cli');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'keep.txt'), 'legacy');

    expect(prepareSkillViewCompatLinks(agentViewRoot)).toBe(0);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(statSync(join(legacy, 'keep.txt')).isFile()).toBe(true);
  });

  it('非 {userId}/{agentId} 结构或视图缺失时安全跳过', () => {
    const root = useTmpDir('mao-skill-view-links-');
    // 末层非数字
    mkdirSync(join(root, 'foo', 'bar'), { recursive: true });
    expect(prepareSkillViewCompatLinks(join(root, 'foo', 'bar'))).toBe(0);
    // 上一层非数字
    mkdirSync(join(root, 'x', '1'), { recursive: true });
    expect(prepareSkillViewCompatLinks(join(root, 'x', '1'))).toBe(0);
    // 视图不存在
    expect(prepareSkillViewCompatLinks(join(root, '9', '9'))).toBe(0);
  });

  it('只为目录补链接，视图根内的散落文件忽略', () => {
    const root = useTmpDir('mao-skill-view-links-');
    const agentViewRoot = join(root, '5', '1');
    mkdirSync(join(agentViewRoot, 'dama-cli'), { recursive: true });
    writeFileSync(join(agentViewRoot, 'stray.txt'), 'x');

    expect(prepareSkillViewCompatLinks(agentViewRoot)).toBe(1);
    expect(lstatSync(join(root, '5', 'stray.txt'), { throwIfNoEntry: false })).toBeUndefined();
  });
});
