import { resolve } from 'node:path';

/** 服务器本地日期（yyyy-MM-dd），按媒体入站时间归档。 */
export function chatFilesDateOf(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 飞书会话入站图片/文件的存储子目录：{workspace}/chat-files/{yyyy-MM-dd}/，避免散落工作区根目录。 */
export function chatFilesDirOf(workspace: string, now = new Date()): string {
  return resolve(workspace, 'chat-files', chatFilesDateOf(now));
}
