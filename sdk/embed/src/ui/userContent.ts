/**
 * 用户气泡内容解析：`@{绝对路径}@`（粘贴文件的引用，也会随历史消息回显）
 * 在气泡里显示为文件名 chip，正文只保留用户真正输入的文字。
 */
const FILE_REF_PATTERN = /@\{([^}]+)\}@/g;

export interface UserFileRef {
  path: string;
  name: string;
}

export interface UserContent {
  text: string;
  files: UserFileRef[];
}

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function parseUserContent(content: string): UserContent {
  const files: UserFileRef[] = [];
  if (!content.includes('@{')) return { text: content, files };
  const text = content
    .replace(FILE_REF_PATTERN, (_match, path: string) => {
      const value = String(path).trim();
      if (value) files.push({ path: value, name: fileNameFromPath(value) });
      return '';
    })
    // 引用是发送时追加在正文末尾的：摘掉后清掉留下的空行/空格
    .trim();
  return { text, files };
}
