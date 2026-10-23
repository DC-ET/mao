import type { SystemSkillNames } from '../skill/user-skill.service.js';

/**
 * 「无系统技能」的判重来源：UserSkillService 构造桩，spec 默认注入。
 * 需要验证同名拦截的用例自行传 `{ getAllNames: () => ['skill-a', ...] }`。
 */
export const noSystemSkillNames: SystemSkillNames = { getAllNames: () => [] };
