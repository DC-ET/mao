/**
 * 剥离消息文本里的内部标记语法，只保留内容本身：
 * ${skill}$ → skill、#{cmd}# → cmd、@{file}@ → file。
 * 这些标记是给引擎解析用的，展示和复制时都不该出现。
 */
export function stripInternalMarkers(text: string): string {
  return text
    .replace(/\$\{([^}]+)\}\$/g, '$1')
    .replace(/#\{([^}]+)\}#/g, '$1')
    .replace(/@\{([^}]+)\}@/g, '$1')
}
