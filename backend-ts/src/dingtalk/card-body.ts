const TITLES = {
  running: '正在处理',
  completed: '处理完成',
  failed: '处理失败',
  cancelled: '任务已取消',
} as const;

/** 卡片正文上限，与飞书进度卡正文（CARD_TEXT_MAX）同为 6000。状态行、回复、工具列表共用这一段。 */
const BODY_MAX = 6000;

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

/**
 * 进度卡正文：`**状态：处理完成** · 共 3 轮 · 耗时 44 秒` + 空行 + 正文 + 工具列表。
 * 与飞书进度卡同构（feishu/progress-card.ts 的 statusLineOf + content + tools），
 * 区别是飞书分三个 markdown 元素，钉钉模板只有一个 markdown 变量，故拼接成单串。
 * @param detail 本轮/终态正文；running 态为流式累积的 assistant 文本，终态为最终回复。
 */
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
  const sections: string[] = [statusLineOf(input.status, input.round, input.elapsedMs)];
  const detail = input.detail?.trim() ?? '';
  if (detail !== '') sections.push(detail);
  const tools = (input.tools ?? []).filter((tool) => tool.trim() !== '');
  if (tools.length > 0) sections.push(`**本轮工具**\n${tools.map((tool) => `- ${tool}`).join('\n')}`);
  return {
    title: TITLES[input.status],
    body: sections.join('\n\n').slice(0, BODY_MAX),
    status: input.status,
    // 按钮可见性用 boolean 变量：钉钉卡片平台只把「boolean 变量 + isTrue/isFalse」
    // 渲染成可用的 @data{...} 条件，字符串 isEqual 比较导入后会被抹成空条件
    // （@triple{'' , 'visible', 'gone'} 恒假），按钮永远不显示。
    canCancel: String(input.status === 'running'),
    canRetry: String(input.status === 'failed'),
    // 合并模板（V192）下三个按钮的可见性变量都要显式下发，无关态置 false——
    // 任何一次 updateCard 都不会留下未声明的 undefined（技术方案 §5.3）。
    canRun: 'false',
    sessionUrl: input.sessionUrl ?? '',
    sessionId: String(input.sessionId),
    senderUserid: input.senderUserid,
  };
}

/** 状态行：`**状态：处理完成** · 共 3 轮 · 耗时 44 秒`（与飞书 statusLineOf 同口径）。 */
function statusLineOf(status: DingtalkProgressStatus, round: number, elapsedMs?: number): string {
  const meta: string[] = [];
  if (round > 0) meta.push(status === 'running' ? `第 ${round} 轮` : `共 ${round} 轮`);
  if (status !== 'running' && elapsedMs != null) meta.push(`耗时 ${formatDingtalkDuration(elapsedMs)}`);
  return `**状态：${TITLES[status]}**${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`;
}

/** 排队卡参数：合并模板（V192）下与进度卡共用 body/status/三 boolean 变量，`preview` 变量已删除。
 *  body 自拼 markdown（状态行 + 队列位次（可选）+ 消息摘要）；rankNo 由调用方在可得时传入（入队时无位次数据则省略）。 */
export function queueCardParams(input: {
  status: 'queued' | 'started' | 'cancelled';
  preview: string;
  queueId: number;
  senderUserid: string;
  rankNo?: number;
}): Record<string, string> {
  const title = input.status === 'queued' ? '排队中' : input.status === 'started' ? '已开始处理' : '已取消';
  const position = input.status === 'queued' && input.rankNo != null && input.rankNo > 0 ? `当前排在第 ${input.rankNo} 位\n\n` : '';
  return {
    title,
    body: `**状态：${title}**\n\n${position}${input.preview.slice(0, 80)}`,
    status: input.status,
    queueId: String(input.queueId),
    senderUserid: input.senderUserid,
    canRun: String(input.status === 'queued'),
    canCancel: 'false',
    canRetry: 'false',
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
