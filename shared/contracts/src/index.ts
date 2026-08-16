// @mao/contracts — 前后端共享的类型契约入口
//
// 约定：
// 1. 仅导出纯类型（interface / type / enum），禁止放入运行时逻辑（函数、类实例、常量值除外）。
// 2. 数据实体（数据库行）、Repository/Service 接口、前端 UI 视图模型均不在此列。
// 3. 后端通过 `export type { X } from '@mao/contracts'` 从自身 types.ts re-export，保持原有 import 路径不变。
// 4. 前端通过 `import type { X } from '@mao/contracts'` 消费，避免重复定义。
//
// 注意：后端采用 Node16 moduleResolution 且本包未标记 "type": "module"，
// 内部 re-export 使用无扩展名相对路径即可（TypeScript 类型检查阶段可解析）。

export type { Result } from './result';
export type { PageQuery, PageResult } from './pagination';
export type { NotificationChannel, TaskNotificationPreference } from './notification';
export type { QuickCommandItem, QuickCommandsVO } from './command';
export type { ToolVO } from './tool';
export type { UserInfoVO, LoginVO } from './user';
export type { ModelVO, ModelPageResult, ModelListFilter } from './model';
export type { ExperienceVO, AgentVO } from './agent';
export type { WeixinPreferenceVO, TaskPanelPreferenceState } from './preference';
export type { AuditLog, AuditListFilter } from './audit';
export type { MessageSearchItem } from './session';
