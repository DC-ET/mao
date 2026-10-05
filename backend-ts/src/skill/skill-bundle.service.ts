import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isValidSkillName, parseSkillMdContent, validateSkillMd } from '../harness/skill/skill-md.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import { isHiddenRelativePath, readSkillFolderFiles, skillFilesPathError } from './read-skill-files.js';
import { writeSkillStaged } from './staged-skill-writer.js';
import {
  SKILL_BUNDLE_FORMAT, SKILL_BUNDLE_FORMAT_VERSION,
  type SkillBundle, type SkillBundleImportReport,
} from './skill-bundle.types.js';

/** 对齐 agent bundle inline：内联文本总量上限（UTF-8 字节）。 */
export const SKILL_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

export interface ParsedSkillBundle {
  name: string;
  description: string | null;
  files: Record<string, string>;
  warnings: string[];
}

type ParseOutcome = { ok: true; parsed: ParsedSkillBundle } | { ok: false; report: SkillBundleImportReport };

/** 用户技能查询能力（UserSkillService 已实现；name 为 SKILL.md frontmatter 名）。 */
export interface SkillBundleUserSkillLookup {
  listUserSkills(userId: number): Array<{ name: string; folderPath: string }> | Promise<Array<{ name: string; folderPath: string }>>;
}

/**
 * mao-skill-bundle v1 导出/导入（资产分发闭环 P3）。
 * 导出：系统技能（无 owner）或指定属主的用户技能；导入：两段式写系统技能目录（exists-skip 不覆盖）。
 */
export class SkillBundleService {
  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly userSkillLookup: SkillBundleUserSkillLookup,
  ) {}

  /** 系统技能是否存在（无 owner 导出分支的路由前置判断）。 */
  hasSystemSkill(name: string): boolean {
    return this.skillLoader.hasSkill(name);
  }

  /** 导出：ownerUserId=null 导出系统技能（要求 skill:read，路由层校验）；否则导出该用户的用户技能。 */
  async exportSkillBundle(name: string, ownerUserId: number | null): Promise<{ bundle: SkillBundle; filename: string }> {
    if (!isValidSkillName(name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `技能名非法：${name}`);
    }
    let folderPath: string | null;
    if (ownerUserId == null) {
      folderPath = this.skillLoader.getSkillFolder(name);
    } else {
      const skills = await this.userSkillLookup.listUserSkills(ownerUserId);
      folderPath = skills.find((s) => s.name === name)?.folderPath ?? null;
    }
    if (folderPath == null) {
      throw new BusinessException(ErrorCode.SKILL_NOT_FOUND);
    }
    const { files, warnings } = readSkillFolderFiles(folderPath, name);
    const doc = parseSkillMdContent(files['SKILL.md'] ?? '');
    const bundle: SkillBundle = {
      format: SKILL_BUNDLE_FORMAT,
      formatVersion: SKILL_BUNDLE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      skill: { name, description: doc?.description ?? null },
      files,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return { bundle, filename: skillBundleFilename(name) };
  }

  /**
   * 两段式导入：confirm=false 返回预检报告（不落盘）；confirm=true 重新执行全部校验后
   * writeSkillStaged 写系统技能目录 + invalidateCache（与 agent bundle inline 导入同语义，exists-skip 不覆盖）。
   */
  importSkillBundle(raw: unknown, confirm: boolean): SkillBundleImportReport {
    const outcome = this.parseAndValidate(raw);
    if (!outcome.ok) return outcome.report;
    const parsed = outcome.parsed;
    if (this.skillLoader.hasSkill(parsed.name)) {
      return {
        name: parsed.name,
        description: parsed.description,
        action: 'exists-skip',
        detail: '系统技能目录已存在同名技能，不覆盖（先删除同名技能才能导入替换）',
        warnings: parsed.warnings,
      };
    }
    if (!confirm) {
      return { name: parsed.name, description: parsed.description, action: 'will-import', warnings: parsed.warnings };
    }
    const written = writeSkillStaged(this.skillLoader.getSkillsDir(), parsed.name, parsed.files);
    if (written.ok) {
      this.skillLoader.invalidateCache();
      return {
        name: parsed.name,
        description: parsed.description,
        action: 'imported',
        detail: '已写入系统技能目录',
        warnings: parsed.warnings,
      };
    }
    return {
      name: parsed.name,
      description: parsed.description,
      action: 'import-failed',
      detail: written.error,
      warnings: parsed.warnings,
    };
  }

  /** 公共校验（两段都执行）：格式识别 + SKILL.md 校验链 + 路径/大小约束。字段级问题以 action=invalid 报告（不抛错）。 */
  private parseAndValidate(raw: unknown): ParseOutcome {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidBundleFormat();
    }
    const bundle = raw as Record<string, unknown>;
    if (bundle.format !== SKILL_BUNDLE_FORMAT || bundle.formatVersion !== SKILL_BUNDLE_FORMAT_VERSION) {
      throw invalidBundleFormat();
    }
    const skill = (bundle.skill ?? {}) as Record<string, unknown>;
    const name = typeof skill.name === 'string' ? skill.name : '';
    const description = typeof skill.description === 'string' && skill.description.trim() !== '' ? skill.description : null;
    const warnings = Array.isArray(bundle.warnings)
      ? bundle.warnings.filter((w): w is string => typeof w === 'string')
      : [];

    const invalid = (detail: string): ParseOutcome => ({ ok: false, report: { name, description, action: 'invalid', detail, warnings } });
    if (!isValidSkillName(name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `bundle 内技能名非法：${name || '（缺失）'}`);
    }
    if (bundle.files == null || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${name}」的 files 必须为对象`);
    }
    const rawFiles = bundle.files as Record<string, unknown>;
    const allString: Record<string, string> = {};
    for (const [path, content] of Object.entries(rawFiles)) {
      if (typeof content !== 'string') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${name}」的文件 ${path} 内容必须为字符串`);
      }
      allString[path] = content;
    }
    // 穿越校验先于隐藏段过滤（对齐 buildImportPlan 顺序：'..' 段不会被隐藏规则静默吞掉）
    const pathError = skillFilesPathError(allString);
    if (pathError != null) return invalid(`路径非法：${pathError}`);
    const files: Record<string, string> = {};
    let totalBytes = 0;
    for (const [path, content] of Object.entries(allString)) {
      if (isHiddenRelativePath(path)) continue;
      files[path] = content;
      totalBytes += Buffer.byteLength(content, 'utf8');
    }
    if (totalBytes > SKILL_BUNDLE_MAX_BYTES) {
      return invalid(`技能文件总量超过 ${Math.floor(SKILL_BUNDLE_MAX_BYTES / 1024 / 1024)}MB 上限`);
    }
    const skillMd = files['SKILL.md'];
    if (skillMd == null) return invalid('bundle 内缺少 SKILL.md');
    const mdError = validateSkillMd(skillMd, name);
    if (mdError != null) return invalid(mdError);
    const frontName = parseSkillMdContent(skillMd)?.name?.trim();
    if (frontName !== name) {
      return invalid(`SKILL.md frontmatter name（${frontName ?? '缺失'}）与技能名（${name}）不一致`);
    }
    return { ok: true, parsed: { name, description, files, warnings } };
  }
}

function invalidBundleFormat(): BusinessException {
  return new BusinessException(ErrorCode.PARAM_INVALID, '不支持的技能 bundle 格式，format/formatVersion 不识别');
}

/** Content-Disposition 文件名仅保留 ASCII 安全子集；中文名清洗为连字符，空则回落 skill。 */
function skillBundleFilename(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return `mao-skill-bundle-${safe || 'skill'}-v1.json`;
}
