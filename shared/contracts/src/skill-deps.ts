/**
 * 技能运行依赖契约（管理后台 Skills 页「运行依赖」列，方案 2026-11-23 skill-runtime-deps）。
 *
 * 后端 `backend-ts/src/skill-deps/` 按技能名聚合各 provider 的依赖条目；
 * admin 汉化表以 `Record<SkillDepsPhase, string>` 声明，漏一项编译期即失败。
 */

/** install：可在服务器上安装；config：读既有配置推导，动作是跳转配置页。 */
export type SkillDepsKind = 'install' | 'config';

export type SkillDepsPhase = 'not_installed' | 'installing' | 'ready' | 'failed';

export interface SkillDepsItem {
  /** provider 内稳定 id，同一技能下唯一。 */
  id: string;
  /** 依赖组名，如「浏览器依赖」。 */
  label: string;
  kind: SkillDepsKind;
  phase: SkillDepsPhase;
  /** tooltip 实况细节；禁止回显凭证。 */
  detail: string | null;
  /** 覆盖 phase 默认文案（如 config 未就绪显示「未配置」）。 */
  text?: string;
  /** config：去配置跳转（admin 路由路径；权限码由前端从路由 meta 解析）。 */
  action?: { label: string; route: string };
  /** install：安装确认弹窗全文。 */
  installConfirm?: string;
}

/** GET /v1/admin/skill-deps/status 的 data.skills；键为技能名，未注册依赖的技能不出现。 */
export type SkillDepsStatusMap = Record<string, { items: SkillDepsItem[] }>;
