import path from 'node:path';

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
  const resolved = path.resolve(workspace);
  for (const channelRoot of channelWorkspaceRoots(workspaceRoot)) {
    const rel = path.relative(channelRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.split(path.sep).length >= 2) return true;
  }
  return false;
}
