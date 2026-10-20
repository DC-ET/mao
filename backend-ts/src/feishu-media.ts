import * as Lark from '@larksuiteoapi/node-sdk';
import { lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { FEISHU_CHAT_DIR } from '../harness/container/channel-workspace.js';

export function resolveFeishuChatWorkspace(root: string, accountId: string, leaf: string): string {
  const safeAccountId = encodeURIComponent(accountId);
  const safeLeaf = encodeURIComponent(leaf);
  const workspaceRoot = resolve(root);
  // 目录名与容器挂载清单（channel-workspace.ts）共用，防两侧漂移导致 docker 模式失效
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

/** 文件落盘文件名清洗：去除路径分隔符与穿越片段，仅保留 basename。 */
export function sanitizeFeishuFileName(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (raw === '') return fallback;
  const basename = raw.replace(/\\/g, '/').split('/').pop() ?? fallback;
  const cleaned = basename.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

/** 引用消息注入文本截断：告警堆栈等长内容防止撑爆用户消息。 */
export function truncateQuoted(text: string, maxLength = 1500): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…（引用内容过长已截断）`;
}

/** 下载消息资源（图片/文件），流式收集并校验大小上限（字节），超限抛错。 */
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
