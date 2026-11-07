import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SkillViewService } from './skill-view.service.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

/**
 * BUGCHECK（round-3 review I-1 回归）：竞态②「他人先换入」分支只容忍了一半——
 * 败者丢弃自己的 stage/.old 后仍写「自己的」指纹到 meta；当胜者内容是另一个源状态
 * （如部署 rsync 落在两次拷贝之间），下次 sync 的指纹短路会把胜者的旧内容错误钉死
 * （幽灵视图）。修复：命中该分支视为「本轮物化未生效」，跳过 meta 写入，保留胜者 meta。
 *
 * 确定性复现：拦截 node:fs 的 renameSync，在第一次「stage → view」换入前注入
 * 「胜者先到」（非空视图 + 胜者 meta '0-0-0'），让真实 rename 以 ENOTEMPTY 失败，
 * 稳定走到竞态②分支；随后再次 ensureView 验证不会把胜者内容钉死。
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const pathMod = await import('node:path');
  return {
    ...actual,
    renameSync: (oldPath: string, newPath: string) => {
      const from = String(oldPath);
      const to = String(newPath);
      const isStageSwap = from.includes(`${pathMod.sep}.tmp${pathMod.sep}`)
        && !to.includes(`${pathMod.sep}.tmp${pathMod.sep}`);
      if (isStageSwap) {
        // 新布局 stage = {viewsRoot}/.tmp/{userId}/{agentId}/{stage}，逐级上溯取根
        const viewsRoot = pathMod.dirname(pathMod.dirname(pathMod.dirname(pathMod.dirname(from))));
        const trigger = pathMod.join(viewsRoot, 'inject-winner-once');
        if (actual.existsSync(trigger)) {
          actual.rmSync(trigger, { force: true }); // 一次性注入
          const agentId = pathMod.basename(pathMod.dirname(from));
          const userId = pathMod.basename(pathMod.dirname(pathMod.dirname(from)));
          const skillName = pathMod.basename(from).split('-').slice(0, -2).join('-');
          // 胜者的完整成果：非空视图 + 与视图内容配对的 meta（指纹故意用占位值）
          actual.mkdirSync(to, { recursive: true });
          actual.writeFileSync(pathMod.join(to, 'SKILL.md'), 'winner-body');
          const winnerMetaDir = pathMod.join(viewsRoot, '.meta', userId, agentId);
          actual.mkdirSync(winnerMetaDir, { recursive: true });
          actual.writeFileSync(
            pathMod.join(winnerMetaDir, `${skillName}.json`),
            JSON.stringify({ source: 'winner', fingerprint: '0-0-0', syncedAt: new Date().toISOString() }),
          );
        }
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

describe('SkillViewService 蓝绿并发（round-3 I-1 回归）', () => {
  function makeSkillSource(root: string, name = 'java', body = 'body-v1'): string {
    const folder = path.join(root, 'skills', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Java\n---\n${body}`);
    return folder;
  }

  it('竞态②命中：保留胜者视图与 meta，下一轮自动重建而非钉死旧内容', async () => {
    const root = useTmpDir('skill-view-race-');
    const source = makeSkillSource(root, 'java', 'body-v1');
    const viewsRoot = path.join(root, 'skill-views');
    const svc = new SkillViewService(viewsRoot);

    // 1) 首次物化（v1）
    const view = await svc.ensureView(7, 5, 'java', source);
    expect(readFileSync(path.join(view!, 'SKILL.md'), 'utf8')).toContain('body-v1');

    // 2) 源更新（长度变化，指纹必然变化）→ 下一次 ensureView 会走物化；顺带布置一次性「胜者注入」
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: java\ndescription: Java\n---\nbody-v2-longer');
    writeFileSync(path.join(viewsRoot, 'inject-winner-once'), 'x');

    // 3) 竞态②：rename(stage → view) 前胜者先到（注入），真实 rename 以 ENOTEMPTY 失败
    const after = await svc.ensureView(7, 5, 'java', source);
    expect(after).toBe(view);
    // 视图归胜者：败者不得用自己拷贝的内容覆盖
    expect(readFileSync(path.join(view!, 'SKILL.md'), 'utf8')).toBe('winner-body');
    // meta 保留胜者的（不得被败者指纹覆盖——被覆盖即 I-1）
    const winnerMeta = JSON.parse(readFileSync(path.join(viewsRoot, '.meta', '7', '5', 'java.json'), 'utf8'));
    expect(winnerMeta.fingerprint).toBe('0-0-0');
    // 败者的 stage/.old 全部清理，无残留
    expect(readdirSync(path.join(viewsRoot, '.tmp', '7', '5'))).toEqual([]);
    // 注入一次性生效（触发文件已消费）
    expect(existsSync(path.join(viewsRoot, 'inject-winner-once'))).toBe(false);

    // 4) 下一轮：胜者 meta 与当前源不匹配 → 重建为最新内容（修复生效：不会短路钉死 winner-body）
    await svc.ensureView(7, 5, 'java', source);
    expect(readFileSync(path.join(view!, 'SKILL.md'), 'utf8')).toContain('body-v2-longer');
    const rebuiltMeta = JSON.parse(readFileSync(path.join(viewsRoot, '.meta', '7', '5', 'java.json'), 'utf8'));
    expect(rebuiltMeta.fingerprint).toMatch(/^\d+-\d+-\d+$/);
  });
});
