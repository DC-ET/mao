export interface DingtalkChannelTool {
  readonly dingtalkChannelTool: true;
}

export function isDingtalkChannelTool(tool: unknown): boolean {
  return tool != null && typeof tool === 'object' && (tool as DingtalkChannelTool).dingtalkChannelTool === true;
}

/** 私聊 projectKey 为 dingtalk-{botId}-private-{userId}，群聊工作区含 /dingtalk-chat/。 */
export function isDingtalkChannelSession(projectKey: string | null | undefined, workspace: string | null | undefined): boolean {
  if (projectKey != null && /^dingtalk-\d+-private-\d+$/.test(projectKey)) return true;
  return (workspace ?? '').replace(/\\/g, '/').includes('/dingtalk-chat/');
}
