/** 飞书进度卡片状态：RUNNING 为执行中，其余为终态。 */
export type FeishuCardStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 进度卡「取消任务」按钮携带的执行归属（点击者须为原发送者）。 */
export interface FeishuProgressCancelAction {
  sessionId: number;
  sender: string;
}

const STATUS_TITLES: Record<FeishuCardStatus, string> = {
  RUNNING: '正在处理',
  COMPLETED: '处理完成',
  FAILED: '处理失败',
  CANCELLED: '任务已取消',
};

/**
 * 构建飞书进度卡片（卡片 JSON 2.0）。
 * 状态行：执行中为「第 n 轮」，终态为「共 n 轮 · 耗时 8 分 26 秒」（无耗时数据时只展示轮数）。
 * @param elapsedMs 任务耗时；仅终态展示，执行中传 undefined 避免节流下展示过期读数。
 */
export function buildFeishuProgressCard(
  status: FeishuCardStatus, round: number, content: string, tools: string[],
  cancelAction?: FeishuProgressCancelAction, elapsedMs?: number,
): Record<string, unknown> {
  const sections: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: statusLineOf(status, round, elapsedMs), text_align: 'left', text_size: 'normal_v2' },
  ];
  if (content.trim() !== '') sections.push({ tag: 'markdown', content: content.slice(0, 6000), text_align: 'left', text_size: 'normal_v2' });
  if (tools.length > 0) sections.push({ tag: 'markdown', content: `**本轮工具**\n${tools.map((tool) => `- ${tool}`).join('\n').slice(0, 3000)}`, text_align: 'left', text_size: 'normal_v2' });
  // 执行中提供「取消任务」按钮（终态 PATCH 不带按钮，随卡片重写自动消失）。
  if (status === 'RUNNING' && cancelAction != null) {
    sections.push({
      // 卡片 JSON 2.0 不支持 tag:'action' 交互模块，按钮需放入 elements（并排用 column_set）。
      tag: 'column_set', flex_mode: 'flow', background_style: 'default',
      columns: [
        { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消任务' }, type: 'danger', value: { kind: 'feishu_progress', act: 'cancel', sessionId: cancelAction.sessionId, sender: cancelAction.sender } }] },
      ],
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: sections },
  };
}

/** 状态行：`**状态：处理完成** · 共 8 轮 · 耗时 8 分 26 秒`。 */
function statusLineOf(status: FeishuCardStatus, round: number, elapsedMs?: number): string {
  const meta: string[] = [];
  if (round > 0) meta.push(status === 'RUNNING' ? `第 ${round} 轮` : `共 ${round} 轮`);
  if (status !== 'RUNNING' && elapsedMs != null) meta.push(`耗时 ${formatFeishuDuration(elapsedMs)}`);
  return `**状态：${STATUS_TITLES[status]}**${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`;
}

/** 耗时文本：`45 秒` / `8 分 26 秒` / `1 小时 2 分`（整分、整时省略零头）。 */
export function formatFeishuDuration(ms: number): string {
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
