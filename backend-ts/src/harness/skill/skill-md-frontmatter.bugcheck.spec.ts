import { describe, expect, it } from 'vitest';
import { parseSkillMdContent, validateSkillMd } from './skill-md.js';

/**
 * 回归用例：SKILL.md frontmatter 按「任意位置的 ---」截断，值里含 --- 时静默损坏。
 *
 * 位置：backend-ts/src/harness/skill/skill-md.ts:20（parseSkillMdContent）与 :50（validateSkillMd）——
 * 结束定界符用 `content.indexOf('---', 3)` 做裸子串搜索，不按行锚定、不理会 YAML 引号/标量。
 * frontmatter 值里出现 `---`（YAML 里完全合法：`---` 只在行首才是文档分隔符）时，
 * frontmatter 被提前截断：description 只剩 `---` 之前的部分，后半段连同真正的定界符被塞进 body。
 *
 * 触发输入是普通中文技能描述，例如「处理步骤 --- 详细说明」；即使加引号
 * （description: "a --- b"）也照样命中，因为扫描不看引号。validateSkillMd 用同一段
 * indexOf 逻辑，损坏内容依然能通过上传/同步校验，没有报错可循。
 *
 * 期望：frontmatter 按行级 `---` 定界符切分，值里的 `---` 原样保留，body 不被污染。
 */
const CONTENT = [
  '---',
  'name: demo',
  'description: 处理步骤 --- 详细说明',
  '---',
  '# 正文',
  '细节',
].join('\n');

const QUOTED_CONTENT = [
  '---',
  'name: demo',
  'description: "a --- b"',
  '---',
  'Body',
].join('\n');

describe('SKILL.md frontmatter delimiter handling', () => {
  it('keeps a --- inside an unquoted frontmatter value', () => {
    const doc = parseSkillMdContent(CONTENT);
    expect(doc?.description).toBe('处理步骤 --- 详细说明');
    expect(doc?.body).toBe('# 正文\n细节');
  });

  it('keeps a --- inside a quoted frontmatter value', () => {
    const doc = parseSkillMdContent(QUOTED_CONTENT);
    expect(doc?.description).toBe('a --- b');
    expect(doc?.body).toBe('Body');
  });

  it('accepts a file whose quoted description contains ---', () => {
    // 当前实现把引号切在中间，YAML 解析失败 → 合法技能文件被拒
    expect(validateSkillMd(QUOTED_CONTENT, 'demo')).toBeNull();
  });

  it('keeps the existing well-formed behavior (control group)', () => {
    const plain = ['---', 'name: demo', 'description: 普通描述', '---', 'Body'].join('\n');
    expect(parseSkillMdContent(plain)).toMatchObject({ name: 'demo', description: '普通描述', body: 'Body' });
    expect(validateSkillMd(plain, 'demo')).toBeNull();
  });
});
