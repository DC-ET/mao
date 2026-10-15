import { lstatSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { DINGTALK_CHAT_DIR } from '../harness/container/channel-workspace.js';

/** {workspaceRoot}/dingtalk-chat/{botId}/{leaf}。leaf 为 p2p-{userId} 或 conversationId。 */
export function resolveDingtalkWorkspace(root: string, botId: string, leaf: string): string {
  const safeBot = encodeURIComponent(botId);
  const safeLeaf = encodeURIComponent(leaf);
  const workspaceRoot = resolve(root);
  // 目录名与容器挂载清单（channel-workspace.ts）共用，防两侧漂移导致 docker 模式失效
  const workspace = resolve(workspaceRoot, DINGTALK_CHAT_DIR, safeBot, safeLeaf);
  for (const candidate of [workspaceRoot, resolve(workspaceRoot, DINGTALK_CHAT_DIR), resolve(workspaceRoot, DINGTALK_CHAT_DIR, safeBot)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error('钉钉会话工作区路径不允许符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rel = relative(workspaceRoot, workspace);
  if (rel.startsWith('..') || rel.includes(`..${'/'}`) || rel.startsWith('/')) {
    throw new Error('钉钉会话工作区路径非法');
  }
  return workspace;
}

export function privateProjectKey(botId: string | number, maoUserId: number): string {
  return `dingtalk-${botId}-private-${maoUserId}`;
}

export function groupProjectKey(botId: string | number, conversationId: string): string {
  return `dingtalk-chat-${botId}-${conversationId}`;
}
