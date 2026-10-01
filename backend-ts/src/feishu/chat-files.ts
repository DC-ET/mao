import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { shanghaiYmd } from '../common/json.js';

/** 归档日期（yyyy-MM-dd，Asia/Shanghai），按媒体入站时间，与微信文件存储口径一致。 */
export function chatFilesDateOf(now: Date = new Date()): string {
  return shanghaiYmd(now);
}

/** 飞书会话入站图片/文件的存储子目录：{workspace}/chat-files/{yyyy-MM-dd}/，避免散落工作区根目录。 */
export function chatFilesDirOf(workspace: string, now: Date = new Date()): string {
  return resolve(workspace, 'chat-files', chatFilesDateOf(now));
}

/**
 * 入站文件落盘目标路径：同日同目录内的同名文件不互相覆盖。
 * 原名未占用时保持原名（人读友好）；已占用则改用 `{主干}-{messageId}{扩展名}`
 * （messageId 单条消息唯一，同消息多文件再追加序号）。历史消息里的 @{路径}@ 引用
 * 因此不会被后到的同名文件篡改——与图片分支的 messageId 命名防覆盖口径对齐。
 */
export function resolveChatFileTarget(dir: string, fileName: string, messageId: string | number, fileIndex = 0): string {
  const target = resolve(dir, fileName);
  if (!existsSync(target)) return target;
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  const indexSuffix = fileIndex > 0 ? `-${fileIndex + 1}` : '';
  return resolve(dir, `${stem}-${messageId}${indexSuffix}${ext}`);
}
