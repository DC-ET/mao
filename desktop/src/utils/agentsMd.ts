/**
 * LOCAL 模式下，读取工作区根目录的 AGENTS.md 文件内容，随消息一起上报给服务端。
 * 服务端会将内容注入到系统提示词末尾（标题为"## 工作区规则"）。
 *
 * 主聊天（useChat.ts）与边路任务（SideChatPanel.vue）均需要在 LOCAL 模式发送/编辑消息前调用。
 *
 * @param workspace 工作区根目录路径
 * @param executionMode 执行模式
 * @param isElectron 是否在 Electron 环境
 * @returns AGENTS.md 文件内容，不存在或读取失败时返回 undefined
 */
export async function collectAgentsMdContent(
  workspace: string | undefined,
  executionMode: string,
  isElectron: boolean
): Promise<string | undefined> {
  if (executionMode !== 'LOCAL' || !isElectron || !workspace) return undefined
  try {
    const result = await (window as any).electronAPI.readAgentsMd(workspace)
    if (!result || result.error || !result.content) {
      return undefined
    }
    return result.content
  } catch {
    return undefined
  }
}
