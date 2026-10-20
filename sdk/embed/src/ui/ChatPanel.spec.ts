import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import ChatPanel from './ChatPanel.vue';
import type { ChatMessage } from '../types';
import type { PageActionLogEntry, PageConfirmRequest } from '../page';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

interface PanelState {
  open: boolean;
  position: 'right' | 'left';
  connected: boolean;
  phase: string | null;
  sessionTitle: string;
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  quotedSelection: string | null;
  suggestedQuestions: string[];
  pageEnabled: boolean;
  pageConfirm: PageConfirmRequest | null;
  pageLogs: PageActionLogEntry[];
}

function mountPanel(overrides: Partial<PanelState> = {}) {
  const props = reactive<PanelState>({
    open: true,
    position: 'right',
    connected: true,
    phase: null,
    sessionTitle: '测试助手',
    sessionError: null,
    llmRetryText: null,
    messages: [],
    quotedSelection: null,
    suggestedQuestions: ['帮我总结当前页面', '这个页面上有什么按钮？'],
    pageEnabled: true,
    pageConfirm: null,
    pageLogs: [],
    ...overrides,
  });
  const sent: Array<{ content: string; attachments: unknown[] }> = [];
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () =>
      h(ChatPanel, {
        ...props,
        agentAvatarUrl: null,
        pendingQuestion: null,
        questionSubmitting: false,
        pageAuthorization: 'per_action',
        pageTaskActive: false,
        maxAttachmentMb: 5,
        historyOpen: false,
        historyItems: [],
        historyLoading: false,
        historyHasMore: false,
        historyError: null,
        activeSessionId: null,
        onSend: (content: string, attachments: unknown[]) => sent.push({ content, attachments }),
        onClose: () => {},
        onNewSession: () => {},
        onToggleHistory: () => {},
        onSelectHistory: () => {},
        onLoadMoreHistory: () => {},
        onStop: () => {},
        onAnswer: () => {},
        onClearSelection: () => {},
        onRetry: () => {},
        onSetPageAuthorization: () => {},
        onResolvePageConfirm: () => {},
      }),
  });
  app.mount(el);
  return { props, sent };
}

function suggestedItems() {
  return [...el.querySelectorAll<HTMLButtonElement>('.mao-suggested__item')];
}

describe('ChatPanel 推荐问题', () => {
  it('空白态渲染推荐问题列表，点击填入输入框而非直接发送', async () => {
    const { sent } = mountPanel();
    const items = suggestedItems();
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe('帮我总结当前页面');

    items[0]!.click();
    await nextTick();
    const input = el.querySelector<HTMLTextAreaElement>('.mao-composer__input')!;
    expect(input.value).toBe('帮我总结当前页面');
    // 点击只填入，不自动发送
    expect(sent).toHaveLength(0);
  });

  it('有消息后不再渲染推荐问题', async () => {
    const { props } = mountPanel();
    expect(suggestedItems()).toHaveLength(2);
    props.messages = [
      {
        id: 'm1',
        role: 'user',
        content: '你好',
        thinking: '',
        streaming: false,
        error: false,
        segments: [{ type: 'text', content: '你好' }],
        toolCalls: [],
      },
    ];
    await nextTick();
    expect(el.querySelector('.mao-suggested')).toBeNull();
  });

  it('推荐问题为空数组时不渲染该区块', () => {
    mountPanel({ suggestedQuestions: [] });
    expect(el.querySelector('.mao-suggested')).toBeNull();
  });
});

describe('ChatPanel 页面操作面板', () => {
  const confirm: PageConfirmRequest = {
    id: 'pc-1',
    tool: 'page_click',
    summary: '点击「保存」',
    risk: 'normal',
    sessionId: 11,
  };

  it('pageEnabled=true 且有待确认动作时渲染动作面板', () => {
    mountPanel({ pageConfirm: confirm });
    expect(el.querySelector('.mao-page__confirm')).not.toBeNull();
    expect(el.querySelector('.mao-page__confirm-text')?.textContent).toContain('点击「保存」');
  });

  it('pageEnabled=false 时即使有待确认动作与日志也不渲染动作面板', () => {
    mountPanel({
      pageEnabled: false,
      pageConfirm: confirm,
      pageLogs: [{
        id: 'log-1', tool: 'page_click', summary: '点击「保存」', status: 'success', risk: 'normal', at: Date.now(),
      }],
    });
    expect(el.querySelector('.mao-page')).toBeNull();
  });
});
