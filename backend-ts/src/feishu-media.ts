import { mkdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { FEISHU_CHAT_DIR } from './harness/container/channel-workspace.js';
import { isBotSender, botSenderLabel } from './feishu/message.service.js';
import { batchResolveFeishuUserNames } from './feishu/sender-names.js';
import { expandFeishuMergeForward } from './feishu/merge-forward.js';
import { chatFilesDirOf, resolveChatFileTarget } from './feishu/chat-files.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { MysqlUserRepository } from './user/user.repository.js';

// ========== 纯工具函数 ==========

export function resolveFeishuChatWorkspace(root: string, accountId: string, leaf: string): string {
  const safeAccountId = encodeURIComponent(accountId);
  const safeLeaf = encodeURIComponent(leaf);
  const workspaceRoot = resolve(root);
  const workspace = resolve(workspaceRoot, FEISHU_CHAT_DIR, safeAccountId, safeLeaf);
  for (const candidate of [workspaceRoot, resolve(workspaceRoot, FEISHU_CHAT_DIR), resolve(workspaceRoot, FEISHU_CHAT_DIR, safeAccountId)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error('飞书会话工作区路径不允许符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rel = relative(workspaceRoot, workspace);
  if (rel.startsWith('..') || rel.includes('..' + '/') || rel.startsWith('/')) {
    throw new Error('飞书会话工作区路径非法');
  }
  return workspace;
}

export function sanitizeFeishuFileName(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (raw === '') return fallback;
  const basename = raw.replace(/\\/g, '/').split('/').pop() ?? fallback;
  const cleaned = basename.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

export function truncateQuoted(text: string, maxLength = 1500): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…（引用内容过长已截断）`;
}

export async function downloadFeishuMediaBuffer(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  const contentType = String((result as { headers?: Record<string, string> }).headers?.['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  const stream = result.getReadableStream();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`飞书资源超出大小限制: ${total} > ${maxBytes}`);
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), contentType };
}

export function dataUriOf(contentType: string, buffer: Buffer): string {
  return `data:${contentType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}

export const IMAGE_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
};

// ========== 工厂函数 ==========

export interface FeishuMediaHelperDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuSenderNames: Map<string, Promise<string | null>>;
  feishuBinding: MysqlFeishuBindingRepository;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  userRepo: MysqlUserRepository;
  workspaceRoot: string;
  maxInboundFileMb: number;
}

export interface FeishuMediaHelper {
  resolveFeishuSenderName(accountId: string, event: FeishuNormalizedMessage): Promise<string | null>;
  resolveFeishuUserNames(accountId: string, openIds: string[]): Promise<Map<string, string>>;
  resolveMergeWorkspace(accountId: string, event: FeishuNormalizedMessage): Promise<string | null>;
  expandMergeForward(accountId: string, messageId: string, workspace: string | null): Promise<string | null>;
  resolveQuotedWorkspace(accountId: string, event: FeishuNormalizedMessage): Promise<string | null>;
  downloadFeishuGroupImage(accountId: string, event: FeishuNormalizedMessage, imageKey: string, index?: number): Promise<string | null>;
  downloadFeishuImageTo(accountId: string, workspace: string, messageId: string, imageKey: string, index?: number): Promise<string | null>;
  downloadFeishuGroupFile(accountId: string, event: FeishuNormalizedMessage): Promise<string | null>;
}

export function createFeishuMediaHelper(deps: FeishuMediaHelperDeps): FeishuMediaHelper {
  const { getFeishuClient, feishuSenderNames, feishuBinding, feishuMessageRepository, userRepo, workspaceRoot, maxInboundFileMb } = deps;

  const resolveFeishuSenderName = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    const senderId = event.senderId;
    if (senderId == null) return null;
    if (isBotSender(event)) return botSenderLabel(event.senderId);
    const key = `${accountId}:${senderId}`;
    const cached = feishuSenderNames.get(key);
    if (cached != null) return cached;
    const lookup = (async (): Promise<string | null> => {
      try {
        const client = await getFeishuClient(Number(accountId));
        if (client == null) return null;
        const response = await client.contact.v3.user.basicBatch({
          data: { user_ids: [senderId] }, params: { user_id_type: 'open_id' },
        });
        const user = (response as { data?: { users?: Array<{ name?: string }> } }).data?.users?.[0];
        return user?.name?.trim() || null;
      } catch (error) {
        console.warn(`获取飞书发送人姓名失败, accountId=${accountId}, openId=${event.senderId}`, error);
        const unionId = event.senderUnionId ?? event.senderId;
        const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
        const bound = userId == null ? null : await userRepo.findById(userId);
        return bound?.displayName?.trim() || null;
      }
    })();
    const name = await lookup;
    if (name != null && name !== '') feishuSenderNames.set(key, Promise.resolve(name));
    return name;
  };

  const resolveFeishuUserNames = async (accountId: string, openIds: string[]): Promise<Map<string, string>> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null || openIds.length === 0) return new Map();
    return batchResolveFeishuUserNames(
      (req) => client.contact.v3.user.basicBatch(req),
      openIds,
      {
        get: (openId) => feishuSenderNames.get(`${accountId}:${openId}`),
        set: (openId, name) => { feishuSenderNames.set(`${accountId}:${openId}`, Promise.resolve(name)); },
      },
    );
  };

  const resolveMergeWorkspace = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    try {
      if (event.chatType === 'group') {
        if (event.chatId == null || event.chatId === '') return null;
        return resolveFeishuChatWorkspace(workspaceRoot, accountId, event.chatId);
      }
      const unionId = event.senderUnionId ?? event.senderId;
      const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
      if (userId == null) return null;
      return resolveFeishuChatWorkspace(workspaceRoot, String(accountId), `private-${userId}`);
    } catch (error) {
      console.warn(`定位合并转发工作区失败, accountId=${accountId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const downloadFeishuImageTo = async (accountId: string, workspace: string, messageId: string, imageKey: string, index = 0): Promise<string | null> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const maxBytes = Math.max(1, maxInboundFileMb) * 1024 * 1024;
    const { buffer, contentType } = await downloadFeishuMediaBuffer(client, messageId, imageKey, 'image', maxBytes);
    if (buffer.length === 0) return null;
    const dir = chatFilesDirOf(workspace);
    mkdirSync(dir, { recursive: true });
    const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] ?? '.jpg';
    const target = resolve(dir, index > 0 ? `feishu-image-${messageId}-${index + 1}${ext}` : `feishu-image-${messageId}${ext}`);
    await writeFile(target, buffer);
    return target;
  };

  const expandMergeForward = async (accountId: string, messageId: string, workspace: string | null): Promise<string | null> => {
    try {
      const client = await getFeishuClient(Number(accountId));
      if (client == null) return null;
      return await expandFeishuMergeForward(client, messageId, {
        workspace,
        resolveUserNames: (openIds) => resolveFeishuUserNames(accountId, openIds),
        downloadImage: async (childMessageId, imageKey, index) => {
          if (workspace == null || workspace === '') return null;
          return downloadFeishuImageTo(accountId, workspace, childMessageId, imageKey, index);
        },
      });
    } catch (error) {
      console.warn(`展开飞书合并转发失败, messageId=${messageId}, code=unknown: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const resolveQuotedWorkspace = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    try {
      if (event.chatType === 'group') {
        if (event.chatId == null) return null;
        const conversation = await feishuMessageRepository.findGroupConversation(String(accountId), event.chatId);
        return conversation?.workspace ?? null;
      }
      const unionId = event.senderUnionId ?? event.senderId;
      const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
      if (userId == null) return null;
      return resolveFeishuChatWorkspace(workspaceRoot, String(accountId), `private-${userId}`);
    } catch (error) {
      console.warn(`定位引用消息工作区失败, accountId=${accountId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const downloadFeishuGroupImage = async (accountId: string, event: FeishuNormalizedMessage, imageKey: string, index = 0): Promise<string | null> => {
    if (event.chatType !== 'group' || event.chatId == null || event.messageId == null) return null;
    const workspace = resolveFeishuChatWorkspace(workspaceRoot, accountId, event.chatId);
    return downloadFeishuImageTo(accountId, workspace, event.messageId, imageKey, index);
  };

  const downloadFeishuGroupFile = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    if (event.chatType !== 'group' || event.chatId == null || event.messageId == null || event.fileKey == null) return null;
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const workspace = resolveFeishuChatWorkspace(workspaceRoot, accountId, event.chatId);
    const maxBytes = Math.max(1, maxInboundFileMb) * 1024 * 1024;
    const { buffer } = await downloadFeishuMediaBuffer(client, event.messageId, event.fileKey, 'file', maxBytes);
    if (buffer.length === 0) return null;
    const dir = chatFilesDirOf(workspace);
    mkdirSync(dir, { recursive: true });
    const fileName = sanitizeFeishuFileName(event.fileName, `feishu-${event.fileKey}`);
    const target = resolveChatFileTarget(dir, fileName, event.messageId);
    await writeFile(target, buffer);
    return target;
  };

  return {
    resolveFeishuSenderName, resolveFeishuUserNames, resolveMergeWorkspace,
    expandMergeForward, resolveQuotedWorkspace, downloadFeishuGroupImage,
    downloadFeishuImageTo, downloadFeishuGroupFile,
  };
}

// ========== 消息文本解析 ==========

export interface ResolveMessageTextDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
}

export function createResolveMessageTextHelper(deps: ResolveMessageTextDeps) {
  const { getFeishuClient } = deps;

  return async (accountId: string, messageId: string): Promise<string | null> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const detail = await fetchFeishuMessageDetail(client, messageId);
    return detail?.text ?? null;
  };
}
