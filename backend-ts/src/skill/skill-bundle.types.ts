/**
 * mao-skill-bundle v1（技能独立搬运格式，见 docs/guides/agent-bundle-format.md）。
 * 约束对齐 agent bundle inline 技能：文本文件、隐藏路径段丢弃、路径穿越拒绝、SKILL.md 校验。
 * bundle 是半可信输入：导入端对所有字段做服务端校验，不信任导出端。
 */

export const SKILL_BUNDLE_FORMAT = 'mao-skill-bundle';
export const SKILL_BUNDLE_FORMAT_VERSION = 1;

export interface SkillBundle {
  format: typeof SKILL_BUNDLE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  skill: {
    name: string;
    description?: string | null;
  };
  /** 相对技能目录路径 → UTF-8 文本内容。二进制文件导出即跳过（文件中不含二进制，导入无需处理）。 */
  files: Record<string, string>;
  /** 导出时的非致命告警（如二进制文件跳过）。 */
  warnings?: string[];
}

export type SkillBundleImportAction = 'will-import' | 'imported' | 'exists-skip' | 'invalid' | 'import-failed';

export interface SkillBundleImportReport {
  name: string;
  description: string | null;
  action: SkillBundleImportAction;
  detail?: string;
  warnings?: string[];
}
