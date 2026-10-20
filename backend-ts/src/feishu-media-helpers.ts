import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { isBotSender, botSenderLabel } from './feishu/message.service.js';
import { batchResolveFeishuUserNames } from './feishu/sender-names.js';
import { expandFeishuMergeForward } from './feishu/merge-forward.js';
import { resolveFeishuChatWorkspace, downloadFeishuMediaBuffer } from './feishu-media.js';
import { chatFilesDirOf, resolveChatFileTarget } from './feishu/chat-files.js';
import { sanitizeFeishuFileName } from './feishu-media.js';
import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { MysqlUserRepository } from './user/user.repository.js';

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

export const IMAGE_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
};

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
    // 同日同名文件防覆盖：命中时改用带 messageId 的唯一名，历史引用不被篡改
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
