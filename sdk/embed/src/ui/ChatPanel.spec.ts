import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import ChatPanel from './ChatPanel.vue';
import type { ChatMessage } from '../types';

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
        pageConfirm: null,
        pageLogs: [],
        maxAttachmentMb: 5,
        onSend: (content: string, attachments: unknown[]) => sent.push({ content, attachments }),
        onClose: () => {},
        onNewSession: () => {},
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
