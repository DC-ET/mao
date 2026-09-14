import { describe, expect, it } from 'vitest';
import { ChatStore, mergeAdjacentToolOnly } from './store';
import type { WsServerEvent } from '@mao/contracts';

function ev(type: string, sessionId: number | null, data?: Record<string, unknown>): WsServerEvent {
  return { type, sessionId, data } as WsServerEvent;
}

describe('ChatStore', () => {
  it('多轮思考、正文与工具按发生顺序记录，结果与重放不移动工具节点', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const send = (type: string, data: Record<string, unknown>) => store.handleEvent(ev(type, 1, data));
    send('thinking_delta', { delta: '先分析' });
    send('content_delta', { delta: '先' });
    send('content_delta', { delta: '搜索' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search' });
    send('tool_call_start', { tool_call_id: 't2', tool_name: 'read_file' });
    send('thinking_delta', { delta: '再分析' });
    send('content_delta', { delta: '继续处理' });
    send('tool_call_start', { tool_call_id: 't3', tool_name: 'shell' });
    send('content_delta', { delta: '最终回答' });
    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: '找到文件' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search' });
    const m = store.messages.value[0];
    expect(m.segments.map((s) => s.type)).toEqual([
      'thinking', 'text', 'tool-group', 'thinking', 'text', 'tool-group', 'text',
    ]);
    expect(m.segments[1]).toEqual({ type: 'text', content: '先搜索' });
    const group = m.segments[2];
    expect(group.type === 'tool-group' && group.toolCalls).toEqual(m.toolCalls.slice(0, 2));
    expect(m.toolCalls[0].resultText).toBe('找到文件');
    expect(m.toolCalls).toHaveLength(3);
    send('llm_stream_reset', {});
    expect(m.segments.map((s) => s.type)).toEqual(['thinking', 'text', 'tool-group']);
    expect(m.toolCalls.map((t) => t.toolCallId)).toEqual(['t1']);
    expect(m.content).toBe('先搜索');
    expect(m.thinking).toBe('先分析');
    send('content_delta', { delta: '重新回答' });
    expect(m.segments.map((s) => s.type)).toEqual(['thinking', 'text', 'tool-group', 'text']);
    expect(m.segments[3]).toEqual({ type: 'text', content: '重新回答' });
  });

  it('content_delta 聚合到最后一条 assistant 消息', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '你好' }));
    store.handleEvent(ev('content_delta', 1, { delta: '世界' }));
    expect(store.messages.value.length).toBe(1);
    expect(store.messages.value[0].content).toBe('你好世界');
    expect(store.messages.value[0].streaming).toBe(true);
  });

  it('重连时纯工具历史轮次不与本地时间线重复', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const id = store.appendLocalUserMessage('搜索');
    store.confirmLocalUserMessage(id, '1');
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'glob_search' }));
    const local = store.messages.value[1];
    await store.reloadHistory(async () => [
      { ...store.messages.value[0], id: 'h_1' },
      { ...local, id: 'h_2', streaming: false },
    ]);
    expect(store.messages.value).toHaveLength(2);
    expect(store.messages.value[1]).toBe(local);
    expect(local.segments).toHaveLength(1);
  });

  it('stale executionId 事件被丢弃', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'a' }));
    // 旧执行的事件
    store.handleEvent(ev('content_delta', 1, { delta: 'stale', executionId: 'e0' }));
    expect(store.messages.value[0].content).toBe('a');
  });

  it('cancel 后抑制流事件，新 RUNNING 恢复', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'x' }));
    store.markCancelled();
    // 被抑制
    store.handleEvent(ev('content_delta', 1, { delta: 'y' }));
    expect(store.messages.value[0].content).toBe('x');
    // 新一轮 RUNNING（无 executionId 的旧事件也要防）
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e2' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'new' }));
    expect(store.messages.value.length).toBe(2);
    expect(store.messages.value[1].content).toBe('new');
  });

  it('CANCELLED 终态终结 running 工具与流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'fs.read' }));
    store.handleEvent(ev('session_status', 1, { phase: 'CANCELLED' }));
    const m = store.messages.value[0];
    expect(m.streaming).toBe(false);
    expect(m.toolCalls[0].status).toBe('error');
    expect(store.phase.value).toBe('CANCELLED');
  });

  it('tool_call_args_delta 用累积全量覆盖（后端 arguments 是快照而非增量）', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    // 后端 agent-loop 内部已累加，每帧下发的都是当前完整 arguments
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'web_search', arguments: '{"q"' }));
    store.handleEvent(ev('tool_call_args_delta', 1, { tool_call_id: 't1', arguments: '{"q":' }));
    store.handleEvent(ev('tool_call_args_delta', 1, { tool_call_id: 't1', arguments: '{"q":"mao"}' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't1', result: 'raw', summary: 'ok', status: 'success' }));
    const tc = store.messages.value[0].toolCalls[0];
    expect(tc.toolCallId).toBe('t1');
    expect(tc.argsText).toBe('{"q":"mao"}');
    expect(tc.status).toBe('done');
    expect(tc.resultText).toBe('ok');
  });

  it('attaches screenshot preview from tool_call_result and local capture', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'page_screenshot' }));
    store.attachImageToRunningTool('page_screenshot', 'data:image/png;base64,local');
    expect(store.messages.value[0].toolCalls[0].imagePreview).toBe('data:image/png;base64,local');
    store.handleEvent(ev('tool_call_result', 1, {
      tool_call_id: 't1', result: '{"path":"page-screenshot.png"}', summary: '截取页面截图', status: 'success',
      preview: { media_type: 'image', mime: 'image/png', data_uri: 'data:image/png;base64,fromws' },
    }));
    expect(store.messages.value[0].toolCalls[0].imagePreview).toBe('data:image/png;base64,fromws');
  });

  it('重复 tool_call_start（subscribe 重放）不产生重复卡片', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"cmd"' }));
    store.handleEvent(ev('tool_call_args_delta', 1, { tool_call_id: 't1', arguments: '{"cmd":"ls"}' }));
    // 服务端重放（同 id，arguments 为重放时刻快照）
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"cmd":"ls"}' }));
    const calls = store.messages.value[0].toolCalls;
    expect(calls.length).toBe(1);
    expect(calls[0].argsText).toBe('{"cmd":"ls"}');
  });

  it('重放帧不回退已累积的 arguments', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"cmd":"ls -la"}' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"cmd"' }));
    expect(store.messages.value[0].toolCalls[0].argsText).toBe('{"cmd":"ls -la"}');
  });

  it('tool_call_result error 状态标记卡片失败', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't2', tool_name: 'fs.write' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't2', result: 'boom', status: 'error' }));
    const tc = store.messages.value[0].toolCalls[0];
    expect(tc.status).toBe('error');
    expect(tc.resultText).toBe('boom');
  });

  it('其他会话的事件被忽略', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 2, { phase: 'RUNNING', executionId: 'e9' }));
    store.handleEvent(ev('content_delta', 2, { delta: 'no' }));
    expect(store.messages.value.length).toBe(0);
    expect(store.phase.value).toBeNull();
  });

  it('error 事件置 FAILED 并收口流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'partial' }));
    store.handleEvent(ev('error', 1, { message: 'boom' }));
    expect(store.phase.value).toBe('FAILED');
    expect(store.sessionError.value).toBe('boom');
    expect(store.messages.value[0].streaming).toBe(false);
    expect(store.messages.value[0].error).toBe(true);
  });

  it('session_snapshot 恢复 executionId 供对账', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_snapshot', 1, { phase: 'RUNNING', executionId: 'e7' }));
    // 重连后旧执行的事件（e6）应被丢弃
    store.handleEvent(ev('content_delta', 1, { delta: 'old', executionId: 'e6' }));
    expect(store.messages.value.length).toBe(0);
    store.handleEvent(ev('content_delta', 1, { delta: 'fresh' }));
    expect(store.messages.value[0].content).toBe('fresh');
  });

  it('session_snapshot 终态终结残留 running 工具与流式光标', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell' }));
    store.handleEvent(ev('content_delta', 1, { delta: '处理中' }));
    // 断线重连后 subscribe 回放终态
    store.handleEvent(ev('session_snapshot', 1, { phase: 'FAILED' }));
    const m = store.messages.value[0];
    expect(m.streaming).toBe(false);
    expect(m.toolCalls[0].status).toBe('error');
    expect(store.phase.value).toBe('FAILED');
  });

  it('session_snapshot COMPLETED 收口流式气泡但不改工具状态', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't1', result: 'ok', status: 'success' }));
    store.handleEvent(ev('session_snapshot', 1, { phase: 'COMPLETED' }));
    const m = store.messages.value[0];
    expect(m.streaming).toBe(false);
    expect(m.toolCalls[0].status).toBe('done');
  });

  it('终态后旧轮次迟到事件被丢弃（cancelledExecutionId 转存）', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'a', executionId: 'e1' }));
    store.handleEvent(ev('session_status', 1, { phase: 'COMPLETED' }));
    // 服务端重放/迟到的同轮事件不得重新拉出流式气泡
    store.handleEvent(ev('content_delta', 1, { delta: 'late', executionId: 'e1' }));
    expect(store.messages.value.length).toBe(1);
    expect(store.messages.value[0].content).toBe('a');
  });

  it('stale CANCELLING 不把已收口的 UI 打回执行中', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.markCancelled();
    store.handleEvent(ev('session_status', 1, { phase: 'CANCELLING' }));
    expect(store.phase.value).not.toBe('CANCELLING');
  });

  it('CANCELLED 终态不解除 cancel 抑制', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'x' }));
    store.markCancelled();
    store.handleEvent(ev('session_status', 1, { phase: 'CANCELLED' }));
    // 抑制仍在：服务端续推的同轮内容必须被丢弃
    store.handleEvent(ev('content_delta', 1, { delta: 'after-cancel' }));
    expect(store.messages.value.map((m) => m.content).join('')).toBe('x');
  });

  it('llm_retry 提示在收到内容后自动清除', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('llm_retry', 1, { reason: 'timeout', attempt: 2, maxRetries: 5 }));
    expect(store.llmRetryText.value).toContain('LLM 重试中');
    store.handleEvent(ev('content_delta', 1, { delta: 'ok' }));
    expect(store.llmRetryText.value).toBeNull();
  });

  it('llm_waiting 不展示内部等待阶段，也不覆盖已有重试提示', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('llm_waiting', 1, { phase: 'response_headers', elapsedSeconds: 1 }));
    expect(store.llmRetryText.value).toBeNull();
    store.handleEvent(ev('llm_retry', 1, { reason: 'timeout', attempt: 2, maxRetries: 5 }));
    const retry = store.llmRetryText.value;
    expect(retry).toContain('LLM 重试中');
    store.handleEvent(ev('llm_waiting', 1, { phase: 'stream_data', elapsedSeconds: 3 }));
    expect(store.llmRetryText.value).toBe(retry);
  });

  it('llm_stream_reset 无已完成工具时清空当前流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell' }));
    store.handleEvent(ev('content_delta', 1, { delta: 'partial' }));
    store.handleEvent(ev('thinking_delta', 1, { delta: 'think' }));
    store.handleEvent(ev('llm_stream_reset', 1, {}));
    const m = store.messages.value[0];
    expect(m.content).toBe('');
    expect(m.thinking).toBe('');
    expect(m.toolCalls.length).toBe(0);
  });

  it('llm_stream_reset 保留已完成工具轮次并丢掉未完成尾巴', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '先检查' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'shell' }));
    store.handleEvent(ev('tool_call_result', 1, { tool_call_id: 't1', status: 'success', result: 'ok' }));
    store.handleEvent(ev('content_delta', 1, { delta: '接着安装' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't2', tool_name: 'shell' }));
    store.handleEvent(ev('llm_stream_reset', 1, {}));
    const m = store.messages.value[0];
    expect(m.content).toBe('先检查');
    expect(m.toolCalls.map((t) => t.toolCallId)).toEqual(['t1']);
    expect(m.segments.map((s) => s.type)).toEqual(['text', 'tool-group']);
  });

  it('llm_stream_reset 不误擦非流式的历史助手消息', () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '上一轮回答' }));
    store.handleEvent(ev('message_end', 1, {}));
    store.handleEvent(ev('llm_stream_reset', 1, {}));
    expect(store.messages.value[0].content).toBe('上一轮回答');
  });

  it('发送失败回滚：移除乐观用户气泡与空助手气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    expect(store.messages.value.length).toBe(2);
    store.rollbackLocalUserMessage(localId);
    expect(store.messages.value.length).toBe(0);
  });

  it('回滚时若助手已有内容则只收口不删除', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '已开始回答' }));
    store.rollbackLocalUserMessage(localId);
    expect(store.messages.value.length).toBe(2);
    expect(store.messages.value[1].streaming).toBe(false);
  });

  it('confirmLocalUserMessage 换成服务端消息 id', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    store.confirmLocalUserMessage(localId, '9527');
    expect(store.messages.value[0].id).toBe('s_9527');
  });

  it('reloadHistory 保留未落库的本地尾部消息', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    // 刚发出、尚未落库确认的用户气泡 + 本轮流式 assistant 气泡
    store.appendLocalUserMessage('新问题');
    await store.reloadHistory(async () => [
      { id: 'h_1', role: 'user', content: 'A', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      { id: 'h_2', role: 'assistant', content: 'B', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
    ]);
    expect(store.messages.value.map((m) => m.content)).toEqual(['A', 'B', '新问题', '']);
    // 流式气泡必须是原对象（延续 delta 写入），否则回答会掐头
    expect(store.messages.value[3].streaming).toBe(true);
  });

  it('reloadHistory 不重复上屏已落库确认的消息', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    store.confirmLocalUserMessage(localId, '7');
    await store.reloadHistory(async () => [
      { id: 'h_7', role: 'user', content: '你好', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      { id: 'h_8', role: 'assistant', content: '回答', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
    ]);
    // 历史已含该消息（h_7 ↔ s_7 同一条），本地副本不再重复
    expect(store.messages.value.map((m) => m.content)).toEqual(['你好', '回答', '']);
  });

  it('reloadHistory 按文本后缀识别带上下文前缀的已落库消息', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.appendLocalUserMessage('帮我看下');
    await store.reloadHistory(async () => [
      {
        id: 'h_9',
        role: 'user',
        content: '[页面上下文]\nurl: x\n\n---\n\n帮我看下',
        thinking: '',
        streaming: false,
        error: false,
        segments: [], toolCalls: [],
      },
    ]);
    // 服务端存的是带前缀的完整内容，本地只存用户输入：不能重复上屏
    expect(store.messages.value.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('markSendUnconfirmed 不删除消息，只收口空的流式气泡', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    store.markSendUnconfirmed(localId);
    expect(store.messages.value).toHaveLength(2);
    expect(store.messages.value[1].streaming).toBe(false);

    // 已有产出时保持流式态，等真实事件收口
    const store2 = new ChatStore();
    store2.bindSession(1);
    const id2 = store2.appendLocalUserMessage('你好');
    store2.handleEvent(ev('content_delta', 1, { delta: '正在回答' }));
    store2.markSendUnconfirmed(id2);
    expect(store2.messages.value[1].streaming).toBe(true);
  });

  it('hasLocalUserMessage 反映乐观气泡是否仍在', () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('你好');
    expect(store.hasLocalUserMessage(localId)).toBe(true);
    store.confirmLocalUserMessage(localId, '3');
    expect(store.hasLocalUserMessage(localId)).toBe(false);
  });

  it('reloadHistory 剔除与本轮流式气泡重复的中间轮次落库行', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const localId = store.appendLocalUserMessage('查一下');
    store.confirmLocalUserMessage(localId, '11');
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '我先查一下' }));
    store.handleEvent(ev('tool_call_start', 1, { tool_call_id: 't1', tool_name: 'grep' }));
    store.handleEvent(ev('content_delta', 1, { delta: '查完了' }));
    // 服务端每个工具轮次结束就落一条 ASSISTANT（单轮片段），本地气泡是全轮拼接
    await store.reloadHistory(async () => [
      { id: 'h_11', role: 'user', content: '查一下', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      { id: 'h_12', role: 'assistant', content: '我先查一下', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
    ]);
    // 片段行不重复上屏，工具卡随本地气泡保留
    expect(store.messages.value.map((m) => m.content)).toEqual(['查一下', '我先查一下查完了']);
    expect(store.messages.value[1].toolCalls).toHaveLength(1);
  });

  it('reloadHistory 尾部仍有未落库用户消息时不做本轮剪裁', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    // 未落库确认的新用户消息 + 本轮流式气泡（文本恰与上一轮历史回答相同）
    store.appendLocalUserMessage('新问题');
    store.handleEvent(ev('session_status', 1, { phase: 'RUNNING', executionId: 'e1' }));
    store.handleEvent(ev('content_delta', 1, { delta: '旧回答' }));
    await store.reloadHistory(async () => [
      { id: 'h_1', role: 'user', content: '旧问题', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      { id: 'h_2', role: 'assistant', content: '旧回答', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
    ]);
    // 本轮用户消息还没落库 → 历史里最后一条 user 之后的行属于上一轮，不能剪
    expect(store.messages.value.map((m) => m.content)).toEqual(['旧问题', '旧回答', '新问题', '旧回答']);
  });

  it('reloadHistory 合并相邻纯工具 assistant，回显只折一组工具调用', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const toolMsg = (id: string, callId: string) => ({
      id,
      role: 'assistant' as const,
      content: '',
      thinking: '',
      streaming: false,
      error: false,
      segments: [{
        type: 'tool-group' as const,
        toolCalls: [{
          toolCallId: callId, toolName: 'sql_query', displayName: 'sql_query',
          argsText: '', status: 'done' as const, resultText: '',
        }],
      }],
      toolCalls: [{
        toolCallId: callId, toolName: 'sql_query', displayName: 'sql_query',
        argsText: '', status: 'done' as const, resultText: '',
      }],
    });
    await store.reloadHistory(async () => [
      { id: 'h_1', role: 'user', content: '查权限', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      toolMsg('h_2', 't1'),
      toolMsg('h_3', 't2'),
      toolMsg('h_4', 't3'),
      { id: 'h_5', role: 'assistant', content: '有权限', thinking: '', streaming: false, error: false, segments: [{ type: 'text', content: '有权限' }], toolCalls: [] },
    ]);
    expect(store.messages.value.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const tools = store.messages.value[1];
    expect(tools.toolCalls.map((t) => t.toolCallId)).toEqual(['t1', 't2', 't3']);
    expect(tools.segments).toHaveLength(1);
    expect(tools.segments[0].type).toBe('tool-group');
    expect(store.messages.value[2].content).toBe('有权限');
  });

  it('mergeAdjacentToolOnly 不合并带正文的 assistant，也不吸收流式气泡', () => {
    const withText = (id: string, content: string, tools: string[]) => ({
      id,
      role: 'assistant' as const,
      content,
      thinking: '',
      streaming: false,
      error: false,
      segments: [
        ...(content ? [{ type: 'text' as const, content }] : []),
        ...tools.map((callId) => ({
          type: 'tool-group' as const,
          toolCalls: [{
            toolCallId: callId, toolName: 'shell', displayName: 'shell',
            argsText: '', status: 'done' as const, resultText: '',
          }],
        })),
      ],
      toolCalls: tools.map((callId) => ({
        toolCallId: callId, toolName: 'shell', displayName: 'shell',
        argsText: '', status: 'done' as const, resultText: '',
      })),
    });
    const streaming = withText('s1', '', ['t9']);
    streaming.streaming = true;
    const merged = mergeAdjacentToolOnly([
      withText('a1', '开始查', ['t1']),
      withText('a2', '', ['t2']),
      withText('a3', '结论', []),
      withText('a4', '', ['t3']),
      streaming,
    ]);
    expect(merged.map((m) => m.id)).toEqual(['a1', 'a3', 'a4', 's1']);
    expect(merged[0].toolCalls.map((t) => t.toolCallId)).toEqual(['t1', 't2']);
    expect(merged[1].content).toBe('结论');
    expect(merged[2].toolCalls.map((t) => t.toolCallId)).toEqual(['t3']);
    expect(merged[3].streaming).toBe(true);
    expect(merged[3].toolCalls.map((t) => t.toolCallId)).toEqual(['t9']);
  });

  it('reloadHistory 期间会话被切换则丢弃结果', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const load = async () => {
      store.bindSession(2);
      return [
        { id: 'h_1', role: 'user' as const, content: 'A', thinking: '', streaming: false, error: false, segments: [], toolCalls: [] },
      ];
    };
    await store.reloadHistory(load);
    expect(store.messages.value.length).toBe(0);
  });
});
