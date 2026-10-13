import path from 'node:path';

/**
 * 把会话工作区内的绝对落盘路径转成工作区相对路径（注入消息文本用，缩短路径）。
 * 不在工作区下（或工作区未知）时保持原样：相对化出错会让 Agent 按错误位置读取，
 * 宁可保留绝对路径。工具侧（read-file/glob/grep/edit-image/shell）均按会话
 * 工作区解析相对路径，与 PromptEngine「请使用工作区相对路径」的口径一致。
 */
export function toWorkspaceRelative(workspace: string | null | undefined, filePath: string): string {
  if (workspace == null || workspace.trim() === '') return filePath;
  const rel = path.relative(path.resolve(workspace), filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel;
}
