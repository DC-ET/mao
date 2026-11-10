import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { ChatStore } from '../core/store';
import type { WsServerEvent } from '@mao/contracts';
import ChatPanel from './ChatPanel.vue';
import type { ChatMessage } from '../types';

/**
 * 执行过程轮次渲染（ChatPanel + useRounds + ThinkingRow/ToolCallGroup/ToolCallRow）：
 * 执行中平铺（思考行/工具组/正文），完成后折叠成「已执行 N 个步骤」条，展开还原全过程，
 * 与桌面端对话页同交互。
 */

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mountPanel(store: ChatStore, phase: string | null = null) {
  const props = reactive({
    open: true,
    position: 'right' as const,
    connected: true,
    phase,
    sessionTitle: '测试助手',
    sessionError: null,
    llmRetryText: null,
    messages: store.messages.value as ChatMessage[],
    suggestedQuestions: [],
    pageEnabled: false,
  });
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () =>
      h(ChatPanel, {
        ...props,
        agentAvatarUrl: null,
        pendingQuestion: null,
        questionSubmitting: false,
        quotedSelection: null,
        pageAuthorization: 'per_action' as const,
        pageTaskActive: false,
        pageConfirm: null,
        pageLogs: [],
        maxAttachmentMb: 5,
        historyOpen: false,
        historyItems: [],
        historyLoading: false,
        historyHasMore: false,
        historyError: null,
        activeSessionId: null,
        onClose: () => {},
        onNewSession: () => {},
        onToggleHistory: () => {},
        onSelectHistory: () => {},
        onLoadMoreHistory: () => {},
        onSend: () => {},
        onStop: () => {},
        onAnswer: () => {},
        onClearSelection: () => {},
        onRetry: () => {},
        onSetPageAuthorization: () => {},
        onResolvePageConfirm: () => {},
      }),
  });
  app.mount(el);
  return props;
}

function setupStore() {
  const store = new ChatStore();
  store.bindSession(1);
  const send = (type: string, data: Record<string, unknown>) => {
    store.handleEvent({ type, sessionId: 1, data } as WsServerEvent);
  };
  return { store, send };
}

describe('执行轮次：执行中平铺', () => {
  it('思考行显示思考中与转圈，工具组显示中文汇总，正文可见，穿插时序保持', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('帮我看下');
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('thinking_delta', { delta: '第一轮思考' });
    send('content_delta', { delta: '准备搜索' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search', arguments: '{"pattern":"*.ts"}' });
    send('tool_call_start', { tool_call_id: 't2', tool_name: 'read_file' });
    const props = mountPanel(store, store.phase.value);
    await nextTick();
    props.phase = store.phase.value;
    await nextTick();

    // 思考行与工具组行（中文汇总）替代旧「思考过程/工具调用」合并展示
    const labels = [...el.querySelectorAll('.mao-think__label, .mao-toolgroup__summary')].map((n) => n.textContent);
    expect(labels[0]).toBe('思考完成');
    expect(labels[1]).toContain('搜索文件');
    expect(labels[1]).toContain('读取文件');
    expect(el.querySelector('.mao-msg__md')?.textContent).toContain('准备搜索');
    // 用户消息仍在
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('帮我看下');
    // 工具执行中不出现等待三点
    expect(el.querySelector('.mao-typing')).toBeNull();
    // 执行中不渲染折叠条
    expect(el.querySelector('.mao-steps')).toBeNull();
    // 思考默认折叠，工具默认折叠
    expect(el.querySelector('.mao-think__body')).toBeNull();
    expect(el.querySelector('.mao-toolgroup__body')).toBeNull();
  });

  it('工具跑完等待下一轮输出时显示三点，正文流出后仍显示', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('提交并部署');
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search' });
    mountPanel(store, 'RUNNING');
    await nextTick();
    expect(el.querySelector('.mao-typing')).toBeNull();

    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: 'ok' });
    await nextTick();
    expect(el.querySelectorAll('.mao-typing span')).toHaveLength(3);

    send('content_delta', { delta: '正文' });
    await nextTick();
    expect(el.querySelectorAll('.mao-typing span')).toHaveLength(3);
  });
});

describe('执行轮次：完成折叠', () => {
  function completedRound(send: (type: string, data: Record<string, unknown>) => void) {
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('thinking_delta', { delta: '先看看结构' });
    send('content_delta', { delta: '先确认工作区状态。' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'shell', arguments: '{"command":"git status"}' });
    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: '{"output":"clean","exit_code":0}', summary: 'git status · 干净' });
    send('tool_call_start', { tool_call_id: 't2', tool_name: 'shell', arguments: '{"command":"git log -1"}' });
    send('tool_call_result', { tool_call_id: 't2', status: 'success', result: '{"output":"c6589591"}', summary: 'git log · 最新提交' });
    send('thinking_delta', { delta: '收尾思考' });
    send('content_delta', { delta: '**提交并部署完成**，版本 0.0.487。' });
    send('message_end', {});
    send('session_status', { phase: 'COMPLETED', executionId: 'e1' });
  }

  it('完成后折叠成步骤条并只显示最终回复，展开还原全过程且回复不重复', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('提交并部署');
    completedRound(send);
    const props = mountPanel(store, 'COMPLETED');
    await nextTick();

    // 折叠条：步骤数 = 2（每轮思考起新步），最终回复在折叠条外常显
    const pill = el.querySelector('.mao-steps') as HTMLButtonElement;
    expect(pill.textContent).toContain('已执行 1 个步骤');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    const replies = [...el.querySelectorAll('.mao-msg__md')].map((n) => n.textContent?.trim());
    expect(replies).toEqual(['提交并部署完成，版本 0.0.487。']);
    // 过程行不在 DOM 中
    expect(el.querySelector('.mao-think')).toBeNull();
    expect(el.querySelector('.mao-toolgroup')).toBeNull();

    // 展开：过程行平铺 + 收尾思考行 + 最终回复（不重复）
    pill.click();
    props.phase = 'COMPLETED';
    await nextTick();
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    const thinkLabels = [...el.querySelectorAll('.mao-think__label')].map((n) => n.textContent);
    expect(thinkLabels).toEqual(['思考完成', '思考完成']);
    expect(el.querySelector('.mao-toolgroup__summary')?.textContent).toBe('2次执行命令');
    const expandedTexts = [...el.querySelectorAll('.mao-msg__md')].map((n) => n.textContent?.trim());
    expect(expandedTexts).toEqual(['先确认工作区状态。', '提交并部署完成，版本 0.0.487。']);
    // 再收起
    (el.querySelector('.mao-steps') as HTMLButtonElement).click();
    await nextTick();
    expect(el.querySelector('.mao-think')).toBeNull();
  });

  it('折叠条带任务耗时：起点用户消息发出、终点本轮最后一条消息结束', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('提交并部署');
    completedRound(send);
    // 模拟时间戳：store 终态已给最后一条 assistant 盖 updatedAt；补齐用户消息起点
    const user = store.messages.value[0];
    const lastAssistant = store.messages.value[store.messages.value.length - 1];
    const t0 = Date.parse(user.createdAt!);
    user.createdAt = new Date(t0).toISOString();
    lastAssistant.updatedAt = new Date(t0 + 994_000).toISOString();
    mountPanel(store, 'COMPLETED');
    await nextTick();
    expect(el.querySelector('.mao-steps')?.textContent).toContain('已执行 1 个步骤');
    expect(el.querySelector('.mao-steps')?.textContent).toContain('任务耗时 16分34秒');
  });

  it('shell 富视图：展开工具行显示终端块（$ 命令 + 输出 + exit 徽标）', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('提交并部署');
    completedRound(send);
    mountPanel(store, 'COMPLETED');
    await nextTick();
    (el.querySelector('.mao-steps') as HTMLButtonElement).click();
    await nextTick();
    // 组头展开 → 两张卡片行（行头为后端 summary）
    (el.querySelector('.mao-toolgroup__header') as HTMLButtonElement).click();
    await nextTick();
    const rows = [...el.querySelectorAll('.mao-toolrow')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.mao-toolrow__summary')?.textContent).toBe('git status · 干净');
    expect(rows[0].querySelector('.mao-toolrow__mark--ok')).toBeTruthy();
    // 展开第一张：终端块
    (rows[0].querySelector('.mao-toolrow__header') as HTMLButtonElement).click();
    await nextTick();
    expect(rows[0].querySelector('.mao-shell__text')?.textContent).toBe('git status');
    expect(rows[0].querySelector('.mao-shell__out')?.textContent).toBe('clean');
    expect(rows[0].querySelector('.mao-badge')?.textContent).toBe('exit 0');
    // 查看原始输入输出开关
    (rows[0].querySelector('.mao-linklike') as HTMLButtonElement).click();
    await nextTick();
    expect(rows[0].querySelector('.mao-code-block__pre')?.textContent).toContain('"command"');
  });

  it('无后端摘要时行头回退中文名 · 入参摘要', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('跑下测试');
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'shell', arguments: '{"command":"npm test"}' });
    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: '{"output":"ok","exit_code":0}' });
    send('message_end', {});
    send('session_status', { phase: 'COMPLETED', executionId: 'e1' });
    mountPanel(store, 'COMPLETED');
    await nextTick();
    (el.querySelector('.mao-steps') as HTMLButtonElement).click();
    await nextTick();
    // 单调用：卡片行头即组壳（无组头）
    expect(el.querySelector('.mao-toolgroup__header')).toBeNull();
    expect(el.querySelector('.mao-toolrow__summary')?.textContent).toBe('执行命令 · npm test');
  });

  it('历史缺失结果显示「结果未记录」，不显示为仍在执行', async () => {
    const { store, send } = setupStore();
    store.appendLocalUserMessage('查下文件');
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search', arguments: '{"pattern":"*"}' });
    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: 'ok' });
    send('message_end', {});
    send('session_status', { phase: 'COMPLETED', executionId: 'e1' });
    store.messages.value[1].toolCalls.forEach((tc) => { tc.status = 'unknown'; });
    mountPanel(store, 'COMPLETED');
    await nextTick();
    (el.querySelector('.mao-steps') as HTMLButtonElement).click();
    await nextTick();
    expect(el.querySelector('.mao-toolrow__unknown')?.textContent).toBe('结果未记录');
    expect(el.querySelector('.mao-spinner')).toBeNull();
  });

  it('截图工具：展开后显示缩略图，点击查看大图，Esc 关闭', async () => {
    const preview = 'data:image/png;base64,aaa';
    const { store, send } = setupStore();
    store.appendLocalUserMessage('截个图');
    send('session_status', { phase: 'RUNNING', executionId: 'e1' });
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'page_screenshot' });
    store.attachImageToRunningTool('page_screenshot', preview);
    send('tool_call_result', { tool_call_id: 't1', result: '{}', summary: '截取页面截图', status: 'success' });
    send('message_end', {});
    send('session_status', { phase: 'COMPLETED', executionId: 'e1' });
    mountPanel(store, 'COMPLETED');
    await nextTick();
    expect(el.querySelector('.mao-toolrow__image')).toBeNull();
    (el.querySelector('.mao-steps') as HTMLButtonElement).click();
    await nextTick();
    // 轮次展开后工具行仍是折叠的：再点行头才见缩略图（对齐桌面端两次展开）
    expect(el.querySelector('.mao-toolrow__thumb')).toBeNull();
    (el.querySelector('.mao-toolrow__header') as HTMLButtonElement).click();
    await nextTick();
    const thumb = el.querySelector('.mao-toolrow__thumb') as HTMLButtonElement;
    (thumb).click();
    await nextTick();
    expect(el.querySelector('.mao-lightbox')).not.toBeNull();
    expect((el.querySelector('.mao-lightbox__img') as HTMLImageElement).src).toBe(preview);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(el.querySelector('.mao-lightbox')).toBeNull();
  });
});

describe('执行轮次：历史形态', () => {
  function historyRound(): ChatMessage[] {
    const t0 = '2026-11-09T15:36:35';
    return [
      {
        id: 'h_1', role: 'user', content: '提交并部署', thinking: '', streaming: false, error: false,
        segments: [{ type: 'text', content: '提交并部署' }], toolCalls: [], createdAt: t0,
      },
      {
        id: 'h_2', role: 'assistant', content: '先确认工作区状态。', thinking: '先看看结构', streaming: false, error: false,
        segments: [
          { type: 'thinking', content: '先看看结构' },
          { type: 'text', content: '先确认工作区状态。' },
          { type: 'tool-group', toolCalls: [{
            toolCallId: 't1', toolName: 'shell', displayName: 'shell',
            argsText: '{"command":"git status"}', status: 'done',
            resultText: '{"output":"clean","exit_code":0}',
          }] },
        ],
        toolCalls: [], createdAt: t0, updatedAt: '2026-11-09T15:52:00',
      },
      {
        id: 'h_3', role: 'assistant', content: '**提交并部署完成**', thinking: '', streaming: false, error: false,
        segments: [{ type: 'text', content: '**提交并部署完成**' }], toolCalls: [],
        createdAt: '2026-11-09T15:52:00', updatedAt: '2026-11-09T15:53:09',
      },
    ];
  }

  it('历史多 assistant 行合并为一轮折叠条，耗时取用户消息到最后一条消息', async () => {
    // 模拟 REST 历史合并后的消息流：每步一条 assistant 行
    const store = new ChatStore();
    store.bindSession(1);
    store.messages.value = historyRound();
    mountPanel(store, 'IDLE');
    await nextTick();
    const pill = el.querySelector('.mao-steps') as HTMLButtonElement;
    expect(pill.textContent).toContain('已执行 1 个步骤');
    expect(pill.textContent).toContain('任务耗时 16分34秒');
    expect([...el.querySelectorAll('.mao-msg__md')].map((n) => n.textContent?.trim()))
      .toEqual(['提交并部署完成']);
    pill.click();
    await nextTick();
    expect(el.querySelector('.mao-think__label')?.textContent).toBe('思考完成');
    expect(el.querySelector('.mao-toolrow__summary')?.textContent).toBe('执行命令 · git status');
  });

  it('纯问答轮（无工具）不渲染折叠条，思考行与正文平铺', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    store.messages.value = [
      {
        id: 'h_10', role: 'user', content: '你好', thinking: '', streaming: false, error: false,
        segments: [{ type: 'text', content: '你好' }], toolCalls: [],
      },
      {
        id: 'h_11', role: 'assistant', content: '你好！有什么可以帮你？', thinking: '问候', streaming: false, error: false,
        segments: [
          { type: 'thinking', content: '问候' },
          { type: 'text', content: '你好！有什么可以帮你？' },
        ],
        toolCalls: [],
      },
    ];
    mountPanel(store, 'IDLE');
    await nextTick();
    expect(el.querySelector('.mao-steps')).toBeNull();
    expect(el.querySelector('.mao-think__label')?.textContent).toBe('思考完成');
    expect(el.querySelector('.mao-msg__md')?.textContent?.trim()).toBe('你好！有什么可以帮你？');
    // 思考行仍可展开
    (el.querySelector('.mao-think__header') as HTMLButtonElement).click();
    await nextTick();
    expect(el.querySelector('.mao-think__content')?.textContent).toBe('问候');
  });
});
