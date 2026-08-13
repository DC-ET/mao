export interface WeixinChannelTool {
  readonly weixinChannelTool: true;
}

export function isWeixinChannelTool(tool: unknown): boolean {
  return tool != null && typeof tool === 'object' && (tool as WeixinChannelTool).weixinChannelTool === true;
}
