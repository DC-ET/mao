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
