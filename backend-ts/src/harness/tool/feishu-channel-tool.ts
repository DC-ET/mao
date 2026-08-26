export interface FeishuChannelTool {
  readonly feishuChannelTool: true;
}

export function isFeishuChannelTool(tool: unknown): boolean {
  return tool != null && typeof tool === 'object' && (tool as FeishuChannelTool).feishuChannelTool === true;
}

/**
 * 判断会话是否属于飞书通道：群聊工作区位于 {root}/feishu-chat/{botId}/{chatId}，
 * 私聊会话 projectKey 固定为 feishu-{botId}-private-{userId}。
 */
export function isFeishuChannelSession(projectKey: string | null | undefined, workspace: string | null | undefined): boolean {
  if (projectKey != null && /^feishu-\d+-private-\d+$/.test(projectKey)) return true;
  return (workspace ?? '').replace(/\\/g, '/').includes('/feishu-chat/');
}
