/**
 * 系统指令可见范围。`all` 全体登录用户；`roles` 仅指定角色（任一命中即可）。
 * 个人指令不使用这个字段。
 */
export type CommandVisibility = 'all' | 'roles';

/**
 * 快捷指令契约（系统 Skill + 用户自定义指令的聚合列表）。
 */
export interface QuickCommandItem {
  type: 'skill' | 'command';
  name: string;
  description: string;
}

export interface QuickCommandsVO {
  skills: QuickCommandItem[];
  commands: QuickCommandItem[];
}
