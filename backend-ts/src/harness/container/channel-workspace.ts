import path from 'node:path';
import type { WorkspaceChannel, WorkspaceChatType } from '@mao/contracts';

/**
 * 通道（飞书 / 钉钉）入站会话的工作区目录名。
 *
 * 宿主机生成侧（create-app 的 resolveFeishuChatWorkspace、dingtalk/workspace.ts）与
 * 容器挂载清单（container-mount-planner 的会话工作区校验）必须共用同一份字面量：
 * 挂载清单按此前缀决定"哪些越出每用户根的会话工作区可以挂进容器"，两侧一旦漂移，
 * docker 模式下通道会话的工作区就会静默失效（容器内目录不存在）。
 *
 * 布局：{workspaceRoot}/feishu-chat/{accountId}/{leaf}，leaf 为群聊 chatId 或
 * private-{userId}；钉钉同构（botId / p2p-{userId}|conversationId）。
 * 群聊工作区由同群多个 mao 用户的会话按设计共享，私聊工作区按 mao 用户隔离。
 */
export const FEISHU_CHAT_DIR = 'feishu-chat';
export const DINGTALK_CHAT_DIR = 'dingtalk-chat';

/** 私聊工作区 leaf：飞书 private-{userId} / 钉钉 p2p-{userId}，捕获组为 mao 用户 id。 */
const PRIVATE_LEAF_RE = /^(?:private|p2p)-(\d+)$/;

/** 通道目录名 → 通道类型（parseChannelWorkspace 与前端标签共用同一映射）。 */
const CHANNEL_BY_DIR: Record<string, WorkspaceChannel> = {
  [FEISHU_CHAT_DIR]: 'feishu',
  [DINGTALK_CHAT_DIR]: 'dingtalk',
};

export interface ChannelWorkspaceRef {
  channel: WorkspaceChannel;
  /** 机器人账号 id（飞书 app_id / 钉钉 botId）。 */
  accountId: string;
  /** 目录名：群 chatId / conversationId，或 private-{userId} / p2p-{userId}。 */
  leaf: string;
  chatType: WorkspaceChatType;
  /** 私聊工作区的 mao 归属用户 id；群聊为 null（按设计多人共享，无单一归属）。 */
  ownerUserId: number | null;
}

/** 通道会话工作区根（相对 workspaceRoot 的一级子目录）。 */
export function channelWorkspaceRoots(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  return [path.join(root, FEISHU_CHAT_DIR), path.join(root, DINGTALK_CHAT_DIR)];
}

/**
 * 是否位于某个通道工作区根之下、且是 {account}/{leaf} 两级及以上的具体工作区。
 * depth >= 2 是硬约束：挂整个通道根或某个账号目录会把其他用户的私聊工作区
 * 一起带进容器，破坏每用户隔离。
 */
export function isChannelWorkspace(workspace: string, workspaceRoot: string): boolean {
  return parseChannelWorkspace(workspace, workspaceRoot) != null;
}

/**
 * 解析通道工作区路径（总览枚举 / 归属校验 / 挂载校验共用）：
 * 必须是 {workspaceRoot}/{feishu-chat|dingtalk-chat}/{accountId}/{leaf} 两级及以上，
 * 否则返回 null（通道根本体、账号级目录、每用户根内路径、无关路径均不算）。
 * 群 leaf 无单一归属（ownerUserId = null）；私聊 leaf 的捕获组即归属用户 id。
 */
export function parseChannelWorkspace(workspace: string, workspaceRoot: string): ChannelWorkspaceRef | null {
  const resolved = path.resolve(workspace);
  const root = path.resolve(workspaceRoot);
  for (const [dir, channel] of Object.entries(CHANNEL_BY_DIR)) {
    const rel = path.relative(path.resolve(root, dir), resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segments = rel.split(path.sep);
    if (segments.length < 2) continue;
    const privateLeaf = PRIVATE_LEAF_RE.exec(segments[1]!);
    return {
      channel,
      accountId: segments[0]!,
      leaf: segments[1]!,
      chatType: privateLeaf ? 'private' : 'group',
      ownerUserId: privateLeaf ? Number(privateLeaf[1]) : null,
    };
  }
  return null;
}
