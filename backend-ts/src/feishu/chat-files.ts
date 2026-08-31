import { resolve } from 'node:path';
import { shanghaiYmd } from '../common/json.js';

/** 归档日期（yyyy-MM-dd，Asia/Shanghai），按媒体入站时间，与微信文件存储口径一致。 */
export function chatFilesDateOf(now: Date = new Date()): string {
  return shanghaiYmd(now);
}

/** 飞书会话入站图片/文件的存储子目录：{workspace}/chat-files/{yyyy-MM-dd}/，避免散落工作区根目录。 */
export function chatFilesDirOf(workspace: string, now: Date = new Date()): string {
  return resolve(workspace, 'chat-files', chatFilesDateOf(now));
}
