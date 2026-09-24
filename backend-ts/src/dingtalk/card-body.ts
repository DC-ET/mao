const TITLES = {
  running: '正在处理',
  completed: '处理完成',
  failed: '处理失败',
  cancelled: '任务已取消',
} as const;

export type DingtalkProgressStatus = keyof typeof TITLES;

export function formatDingtalkDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}

export function progressCardParams(input: {
  status: DingtalkProgressStatus;
  round: number;
  elapsedMs?: number;
  tools?: string[];
  detail?: string;
  sessionUrl?: string;
  sessionId: number;
  senderUserid: string;
}): Record<string, string> {
  const meta: string[] = [];
  if (input.round > 0) meta.push(input.status === 'running' ? `第 ${input.round} 轮` : `共 ${input.round} 轮`);
  if (input.status !== 'running' && input.elapsedMs != null) meta.push(`耗时 ${formatDingtalkDuration(input.elapsedMs)}`);
  const lines = [meta.join(' · ')];
  const tools = (input.tools ?? []).filter((tool) => tool.trim() !== '');
  if (tools.length > 0) lines.push(tools.map((tool) => `- ${tool}`).join('\n'));
  if (input.detail != null && input.detail.trim() !== '') lines.push(input.detail.trim());
  return {
    title: TITLES[input.status],
    body: lines.filter((line) => line !== '').join('\n').slice(0, 1500),
    status: input.status,
    sessionUrl: input.sessionUrl ?? '',
    sessionId: String(input.sessionId),
    senderUserid: input.senderUserid,
  };
}

export function queueCardParams(input: {
  status: 'queued' | 'started' | 'cancelled';
  preview: string;
  queueId: number;
  senderUserid: string;
}): Record<string, string> {
  const title = input.status === 'queued' ? '排队中' : input.status === 'started' ? '已开始处理' : '已取消';
  return {
    title,
    preview: input.preview.slice(0, 80),
    status: input.status,
    queueId: String(input.queueId),
    senderUserid: input.senderUserid,
  };
}

export function cardCallbackResponse(cardParamMap: Record<string, string> | null, tips?: string): Record<string, unknown> {
  const response: Record<string, unknown> = {
    cardUpdateOptions: {
      updateCardDataByKey: cardParamMap != null,
      updatePrivateDataByKey: tips != null && tips !== '',
    },
  };
  if (cardParamMap != null) response.cardData = { cardParamMap };
  if (tips != null && tips !== '') response.userPrivateData = { cardParamMap: { tips } };
  return response;
}
