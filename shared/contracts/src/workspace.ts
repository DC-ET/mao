/**
 * 工作区总览契约（桌面「我的工作区」页签 ↔ 后端 file 域共用）。
 *
 * 枚举一律走本文件下沉：两端汉化表用 `Record<契约联合, 文案>` 声明，
 * 漏项编译期即失败（AGENTS.md 跨端枚举规范）。
 */

/** 总览条目类别：临时工作区（会话 id 目录）/ 项目 / 其他 / 机器人通道。 */
export type WorkspaceKind = 'temp' | 'project' | 'other' | 'channel';

/** 机器人通道类型：kind === 'channel' 的条目按此区分飞书 / 钉钉。 */
export type WorkspaceChannel = 'feishu' | 'dingtalk';

/**
 * 通道会话类型：
 * - group：leaf 为群 chatId / conversationId，同群多个 mao 用户的会话按设计共享；
 * - private：leaf 为 `private-{userId}`（飞书）/ `p2p-{userId}`（钉钉），按 mao 用户隔离。
 */
export type WorkspaceChatType = 'group' | 'private';
