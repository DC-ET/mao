import type { FeishuInboundContext } from './feishu/types.js';

/** 排队交互卡片：提示当前任务执行中、新消息已入队，并提供「立即发送/取消排队」两个按钮。 */
export function buildFeishuQueueCard(context: FeishuInboundContext, queueId: number, position: number): Record<string, unknown> {
  const summary = context.text.length > 60 ? `${context.text.slice(0, 60)}…` : context.text;
  // 私聊是一对一对话，对端即用户本人，无需（也不应）显示「发送者：」前缀；群聊则保留发送者名以区分多人。
  const showSender = context.chatType === 'group';
  const senderLabel = (context.senderLabel?.trim() || '用户');
  const body = showSender ? `${senderLabel}：${summary}` : summary;
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical', padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: '**⏳ 任务排队中**', text_align: 'left', text_size: 'normal_v2' },
        { tag: 'markdown', content: `当前任务正在执行中，这条消息已进入队列（第 ${position} 位），将在当前任务完成后自动开始处理。`, text_align: 'left', text_size: 'normal_v2' },
        { tag: 'markdown', content: body, text_align: 'left', text_size: 'normal_v2' },
        {
          // 卡片 JSON 2.0 不支持 tag:'action' 交互模块，按钮需放入 elements（并排用 column_set）。
          tag: 'column_set', flex_mode: 'flow', background_style: 'default',
          columns: [
            { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '立即发送' }, type: 'primary', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'run' } }] },
            { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消排队' }, type: 'default', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'cancel' } }] },
          ],
        },
      ],
    },
  };
}
