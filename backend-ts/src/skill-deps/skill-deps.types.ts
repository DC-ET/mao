import type { SkillDepsItem } from '@mao/contracts';

export type { SkillDepsKind, SkillDepsPhase, SkillDepsItem, SkillDepsStatusMap } from '@mao/contracts';

/**
 * 单个技能的运行依赖 provider（方案 2026-11-23 skill-runtime-deps D1/§4.1）：
 * 状态探测、安装链、存储均由 provider 自持，SkillDepsService 只做聚合与派发。
 */
export interface SkillDepsProvider {
  /** 必须等于技能 frontmatter name。 */
  readonly skillName: string;
  /** 只读、可重复调用；异常与超时由 SkillDepsService 隔离。 */
  status(): Promise<SkillDepsItem[]>;
  /** 含 install 类条目的 provider 必须实现；一次调用负责该技能全部可安装项。 */
  install?(): Promise<{ started: boolean }>;
  /** Agent / 角色授权保存时触发，收到完整技能名单后自行过滤；fire-and-forget，自吞异常。 */
  ensureForSkills?(skillNames: readonly string[]): void;
}
