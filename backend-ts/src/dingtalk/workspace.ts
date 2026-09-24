import { lstatSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** {workspaceRoot}/dingtalk-chat/{botId}/{leaf}。leaf 为 p2p-{userId} 或 conversationId。 */
export function resolveDingtalkWorkspace(root: string, botId: string, leaf: string): string {
  const safeBot = encodeURIComponent(botId);
  const safeLeaf = encodeURIComponent(leaf);
  const workspaceRoot = resolve(root);
  const workspace = resolve(workspaceRoot, 'dingtalk-chat', safeBot, safeLeaf);
  for (const candidate of [workspaceRoot, resolve(workspaceRoot, 'dingtalk-chat'), resolve(workspaceRoot, 'dingtalk-chat', safeBot)]) {
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
