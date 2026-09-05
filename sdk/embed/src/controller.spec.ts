import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { EmbedController, createUiState, type UiState } from './controller';
import type { MaoChatEvent, MaoChatInitOptions } from './types';

/** 与 ws-client.spec.ts 同款 fake：静态常量必须保留 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static constructThrows = false;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { target: unknown; data: string }) => void) | null = null;
  onclose: ((e: { target: unknown; code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    if (FakeWebSocket.constructThrows) throw new Error("Failed to construct 'URL': Invalid URL");
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(payload);
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ target: this, code });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(obj: unknown) {
    this.onmessage?.({ target: this, data: JSON.stringify(obj) });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type);
  }
}

const SESSION_ID = 42;

interface Harness {
  ctl: EmbedController;
  ui: UiState;
  events: MaoChatEvent[];
  socket: () => FakeWebSocket;
  fetchCalls: string[];
}

function jsonOk(data: unknown) {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ code: 0, data }),
  } as unknown as Response;
}

let historyMessages: Array<Record<string, unknown>> = [];

function installFetch(fetchCalls: string[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push(`${method} ${url}`);
    if (method === 'POST' && url.includes('/sessions')) {
      return jsonOk({ id: SESSION_ID, title: '网页助手' });
    }
    if (url.includes(`/sessions/${SESSION_ID}/messages`)) {
      return jsonOk({ messages: historyMessages, hasMore: false });
    }
    if (url.includes(`/sessions/${SESSION_ID}`)) {
      return jsonOk({ id: SESSION_ID, title: '网页助手' });
    }
    return jsonOk({});
  }) as unknown as typeof fetch;
}

async function makeHarness(overrides: Partial<MaoChatInitOptions> = {}): Promise<Harness> {
  const events: MaoChatEvent[] = [];
  const fetchCalls: string[] = [];
  installFetch(fetchCalls);
  const options: MaoChatInitOptions = {
    serverUrl: 'https://mao.example.com',
    agentId: 3,
    getToken: async () => 'fake.jwt.token',
    ...overrides,
  };
  const ui = createUiState(options);
  const ctl = new EmbedController(options, ui, (e) => events.push(e), () => {}, null);
  return { ctl, ui, events, socket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1], fetchCalls };
}

/** 完成 boot：open() → 会话解析 → socket OPEN → connected 帧 */
async function boot(h: Harness) {
  h.ctl.open();
  // 等 tabs.inquire(300ms) + REST 往返
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 2000 });
  const socket = h.socket();
  socket.open();
  await vi.waitFor(() => expect(socket.framesOfType('auth').length).toBe(1));
  socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
  await nextTick();
  return socket;
}

describe('EmbedController', () => {
  let originalWs: typeof WebSocket;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalWs = globalThis.WebSocket;
    originalFetch = globalThis.fetch;
    FakeWebSocket.instances = [];
    FakeWebSocket.constructThrows = false;
    historyMessages = [];
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    window.localStorage.clear();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWs;
    globalThis.fetch = originalFetch;
  });

  it('boot 后 subscribe 只发一次，ui.connected 随鉴权双向同步', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    expect(socket.framesOfType('subscribe')).toEqual([{ type: 'subscribe', sessionId: SESSION_ID }]);
    expect(h.ui.connected).toBe(true);

    // 断线：UI 必须回到未连接态（否则输入框仍可用、指示灯说谎）
    socket.close(1006);
    await nextTick();
    expect(h.ui.connected).toBe(false);
    h.ctl.destroy();
  });

  it('send 失败时回滚乐观气泡并保留上下文与引用', async () => {
    const h = await makeHarness({ context: () => ({ page: 'order' }) });
    const socket = await boot(h);
    // socket 关闭 + 构造失败 → sendReliable 必然 false
    socket.close(1006);
    FakeWebSocket.constructThrows = true;
    await h.ctl.send('你好');
    expect(h.ctl.store.messages.value).toHaveLength(0);
    expect(h.ui.sessionError).toContain('发送失败');
    h.ctl.destroy();
  });

  it('send 成功后 user_message_saved 把本地 id 换成服务端 id', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    await h.ctl.send('你好');
    const frame = socket.framesOfType('send_message')[0] as {
      sessionId: number;
      data: { content: string; eventId: string };
    };
    expect(frame.sessionId).toBe(SESSION_ID);
    expect(frame.data.content).toBe('你好');
    socket.emit({
      type: 'user_message_saved',
      sessionId: SESSION_ID,
      data: { tempEventId: frame.data.eventId, messageId: 9527 },
    });
    expect(h.ctl.store.messages.value[0].id).toBe('s_9527');
    h.ctl.destroy();
  });

  it('自己发送的消息不计未读，外部渠道消息补插并计未读', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    await h.ctl.send('你好');
    const frame = socket.framesOfType('send_message')[0] as { data: { eventId: string } };
    h.ctl.close();
    socket.emit({
      type: 'user_message_saved',
      sessionId: SESSION_ID,
      data: { tempEventId: frame.data.eventId, messageId: 1 },
    });
    expect(h.ctl.store.unread.value).toBe(0);

    socket.emit({
      type: 'user_message_saved',
      sessionId: SESSION_ID,
      data: { messageId: 2, source: 'weixin', content: '微信来的消息', tempEventId: '' },
    });
    expect(h.ctl.store.unread.value).toBe(1);
    expect(h.ctl.store.messages.value.some((m) => m.content === '微信来的消息')).toBe(true);
    h.ctl.destroy();
  });

  it('session_already_running 立即回滚乐观气泡', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    await h.ctl.send('你好');
    expect(h.ctl.store.messages.value).toHaveLength(2);
    socket.emit({
      type: 'session_already_running',
      sessionId: SESSION_ID,
      data: { message: '该任务仍在运行，请先停止当前执行后再继续' },
    });
    await nextTick();
    expect(h.ctl.store.messages.value).toHaveLength(0);
    expect(h.ui.sessionError).toContain('仍在运行');
    h.ctl.destroy();
  });

  it('stop 失败不进入抑制态，成功才乐观置 CANCELLED', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.emit({ type: 'session_status', sessionId: SESSION_ID, data: { phase: 'RUNNING', executionId: 'e1' } });
    socket.emit({ type: 'content_delta', sessionId: SESSION_ID, data: { delta: 'A', executionId: 'e1' } });

    socket.close(1006);
    FakeWebSocket.constructThrows = true;
    await h.ctl.stop();
    expect(h.ui.sessionError).toContain('停止失败');
    // 未抑制：恢复连接后同轮内容仍能继续渲染
    FakeWebSocket.constructThrows = false;
    h.ctl.store.handleEvent({
      type: 'content_delta',
      sessionId: SESSION_ID,
      data: { delta: 'B', executionId: 'e1' },
    } as never);
    expect(h.ctl.store.messages.value[0].content).toBe('AB');
    h.ctl.destroy();
  });

  it('stop 成功后乐观切回 CANCELLED 并抑制后续同轮事件', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.emit({ type: 'session_status', sessionId: SESSION_ID, data: { phase: 'RUNNING', executionId: 'e1' } });
    socket.emit({ type: 'content_delta', sessionId: SESSION_ID, data: { delta: 'A', executionId: 'e1' } });
    await h.ctl.stop();
    expect(socket.framesOfType('cancel')).toEqual([{ type: 'cancel', sessionId: SESSION_ID }]);
    expect(h.ctl.store.phase.value).toBe('CANCELLED');
    socket.emit({ type: 'content_delta', sessionId: SESSION_ID, data: { delta: 'B', executionId: 'e1' } });
    expect(h.ctl.store.messages.value[0].content).toBe('A');
    h.ctl.destroy();
  });

  it('追问回答按 outputSchema 形状发送且禁止重复提交', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.emit({
      type: 'ask_user_questions',
      sessionId: SESSION_ID,
      data: { requestId: 'rq1', questions: [{ question: '选哪个？', options: [{ label: 'A' }] }] },
    });
    await nextTick();
    expect(h.ui.pendingQuestion?.requestId).toBe('rq1');

    await h.ctl.answer('rq1', [{ question: '选哪个？', selectedLabels: ['A'], customInput: null }]);
    const sentFrames = socket.framesOfType('ask_user_questions_result');
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({
      sessionId: SESSION_ID,
      data: { requestId: 'rq1', answers: [{ question: '选哪个？', selectedLabels: ['A'], customInput: null }] },
    });
    // 提交后卡片保留（等服务端 cancelled），且不允许重复提交
    expect(h.ui.pendingQuestion?.requestId).toBe('rq1');
    expect(h.ui.questionSubmitting).toBe(true);
    await h.ctl.answer('rq1', [{ question: '选哪个？', selectedLabels: ['A'], customInput: null }]);
    expect(socket.framesOfType('ask_user_questions_result')).toHaveLength(1);

    socket.emit({ type: 'ask_user_questions_cancelled', sessionId: SESSION_ID, data: { requestId: 'rq1' } });
    await nextTick();
    expect(h.ui.pendingQuestion).toBeNull();
    expect(h.ui.questionSubmitting).toBe(false);
    h.ctl.destroy();
  });

  it('追问提交失败时保留卡片并解锁重试', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.emit({
      type: 'ask_user_questions',
      sessionId: SESSION_ID,
      data: { requestId: 'rq2', questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
    });
    await nextTick();
    socket.close(1006);
    FakeWebSocket.constructThrows = true;
    await h.ctl.answer('rq2', [{ question: 'Q', selectedLabels: ['A'], customInput: null }]);
    expect(h.ui.pendingQuestion?.requestId).toBe('rq2');
    expect(h.ui.questionSubmitting).toBe(false);
    expect(h.ui.sessionError).toContain('提交失败');
    h.ctl.destroy();
  });

  it('重连后重拉历史对账', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    const firstCount = h.fetchCalls.filter((c) => c.includes('/messages')).length;
    expect(firstCount).toBe(1);

    historyMessages = [
      { id: 1, role: 'USER', content: '问题' },
      { id: 2, role: 'ASSISTANT', content: '断线期间产生的回答' },
    ];
    socket.close(1006);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const s2 = h.socket();
    s2.open();
    await vi.waitFor(() => expect(s2.framesOfType('auth').length).toBe(1));
    s2.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
    await vi.waitFor(() =>
      expect(h.ctl.store.messages.value.map((m) => m.content)).toEqual(['问题', '断线期间产生的回答']),
    );
    h.ctl.destroy();
  });

  it('历史里的用户消息剥掉上下文前缀后上屏（不回显 JSON 上下文块）', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    historyMessages = [
      {
        id: 1,
        role: 'USER',
        content: '[页面上下文]\nurl: https://erp.example.com/order\ntitle: 订单\ndata: {"orderId":"SO-1"}\n\n---\n\n这单什么状态？',
      },
    ];
    socket.close(1006);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const s2 = h.socket();
    s2.open();
    await vi.waitFor(() => expect(s2.framesOfType('auth').length).toBe(1));
    s2.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
    await vi.waitFor(() =>
      expect(h.ctl.store.messages.value.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
        '这单什么状态？',
      ]),
    );
    h.ctl.destroy();
  });

  it('重连重拉历史不擦掉本轮流式内容与工具卡', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    historyMessages = [{ id: 1, role: 'USER', content: '问题' }];
    socket.close(1006);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const s2 = h.socket();
    s2.open();
    await vi.waitFor(() => expect(s2.framesOfType('auth').length).toBe(1));
    // 服务端 subscribe 重放先于 REST 返回：流式气泡与工具卡在此建立
    s2.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
    s2.emit({ type: 'session_snapshot', sessionId: SESSION_ID, data: { phase: 'RUNNING', executionId: 'e9' } });
    s2.emit({
      type: 'tool_call_start',
      sessionId: SESSION_ID,
      data: { tool_call_id: 'tc9', tool_name: 'shell', arguments: '{}', executionId: 'e9' },
    });
    s2.emit({ type: 'content_delta', sessionId: SESSION_ID, data: { delta: '本轮', executionId: 'e9' } });

    await vi.waitFor(() =>
      expect(h.ctl.store.messages.value.map((m) => m.content)).toEqual(['问题', '本轮']),
    );
    // 工具卡仍在原气泡上，后续 result 才能按 id 命中
    const streaming = h.ctl.store.messages.value[1];
    expect(streaming.toolCalls.map((t) => t.toolCallId)).toEqual(['tc9']);
    s2.emit({
      type: 'tool_call_result',
      sessionId: SESSION_ID,
      data: { tool_call_id: 'tc9', result: 'ok', status: 'success', executionId: 'e9' },
    });
    expect(streaming.toolCalls[0].status).toBe('done');
    expect(streaming.toolCalls).toHaveLength(1);
    h.ctl.destroy();
  });

  it('落库确认超时只提示未确认，不删除用户消息', async () => {
    vi.useFakeTimers();
    try {
      const h = await makeHarness();
      h.ctl.open();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 5000 });
      const socket = h.socket();
      socket.open();
      await vi.waitFor(() => expect(socket.framesOfType('auth').length).toBe(1));
      socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });

      await h.ctl.send('你好');
      expect(h.ctl.store.messages.value).toHaveLength(2);
      // 60s 未收到 user_message_saved；期间保持连接存活（否则 30s 静默判定会关连接并暂停计时）
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        socket.emit({ type: 'pong', sessionId: null, data: {} });
      }
      expect(h.ctl.store.messages.value.map((m) => m.content)).toEqual(['你好', '']);
      expect(h.ui.sessionError).toContain('未确认');
      h.ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('落库确认超时后迟到的回执仍升级 id 并撤下提示', async () => {
    vi.useFakeTimers();
    try {
      const h = await makeHarness();
      h.ctl.open();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 5000 });
      const socket = h.socket();
      socket.open();
      await vi.waitFor(() => expect(socket.framesOfType('auth').length).toBe(1));
      socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });

      await h.ctl.send('你好');
      const eventId = (socket.framesOfType('send_message')[0] as { data: { eventId: string } }).data.eventId;
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        socket.emit({ type: 'pong', sessionId: null, data: {} });
      }
      expect(h.ui.sessionError).toContain('未确认');
      // 回执迟到：气泡必须换成服务端 id，提示撤下
      socket.emit({
        type: 'user_message_saved',
        sessionId: SESSION_ID,
        data: { tempEventId: eventId, messageId: 77 },
      });
      await nextTick();
      expect(h.ctl.store.messages.value[0].id).toBe('s_77');
      expect(h.ui.sessionError).toBeNull();
      h.ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('落库超时提示在服务端产出后自动撤下', async () => {
    vi.useFakeTimers();
    try {
      const h = await makeHarness();
      h.ctl.open();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 5000 });
      const socket = h.socket();
      socket.open();
      await vi.waitFor(() => expect(socket.framesOfType('auth').length).toBe(1));
      socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });

      await h.ctl.send('你好');
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        socket.emit({ type: 'pong', sessionId: null, data: {} });
      }
      expect(h.ui.sessionError).toContain('未确认');
      socket.emit({ type: 'content_delta', sessionId: SESSION_ID, data: { delta: '在回答了' } });
      await nextTick();
      expect(h.ui.sessionError).toBeNull();
      h.ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('断线暂停落库计时，重连对账后已落库则不再提示', async () => {
    vi.useFakeTimers();
    try {
      const h = await makeHarness();
      h.ctl.open();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 5000 });
      const socket = h.socket();
      socket.open();
      await vi.waitFor(() => expect(socket.framesOfType('auth').length).toBe(1));
      socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
      await h.ctl.send('你好');

      // 断线：user_message_saved 不会补推，若继续计时必然误报
      historyMessages = [{ id: 5, role: 'USER', content: '你好' }];
      socket.close(1006);
      await vi.advanceTimersByTimeAsync(2_000);
      const s2 = h.socket();
      s2.open();
      await vi.advanceTimersByTimeAsync(10);
      s2.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
      // REST 对账：历史里已有该消息 → 视为已落库，销账
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.ui.sessionError).toBeNull();
      expect(h.ctl.store.messages.value.filter((m) => m.role === 'user')).toHaveLength(1);
      h.ctl.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('鉴权失败横幅在重新鉴权成功后自动消失', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.close(1003);
    await nextTick();
    expect(h.ui.sessionError).toContain('登录凭据已失效');
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const s2 = h.socket();
    s2.open();
    await vi.waitFor(() => expect(s2.framesOfType('auth').length).toBe(1));
    s2.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
    await nextTick();
    expect(h.ui.sessionError).toBeNull();
    h.ctl.destroy();
  });

  it('boot 连接失败时展示中文文案，原始错误经 onEvent 给宿主', async () => {
    FakeWebSocket.constructThrows = true;
    const h = await makeHarness();
    h.ctl.open();
    await vi.waitFor(() => expect(h.ui.sessionError).not.toBeNull(), { timeout: 2000 });
    expect(h.ui.sessionError).toBe('无法连接到助手服务，请检查网络后重试');
    expect(h.events.some((e) => e.type === 'error' && e.message.includes('Failed to construct'))).toBe(true);
    h.ctl.destroy();
  });

  it('clearSelection 后发送不再携带引用块', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    // 模拟选中触发：直接写 ui（tracker 的 debounce 回调等价路径）
    h.ui.quotedSelection = '这段很重要';
    h.ctl.clearSelection();
    expect(h.ui.quotedSelection).toBeNull();
    await h.ctl.send('帮我看下');
    const frame = socket.framesOfType('send_message')[0] as { data: { content: string } };
    expect(frame.data.content).not.toContain('[用户选中文本]');
    h.ctl.destroy();
  });

  it('newSession 退订旧会话并订阅新会话', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    // 让新会话返回不同 id
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/sessions')) {
        return jsonOk({ id: 99, title: '网页助手' });
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    await h.ctl.newSession();
    expect(socket.framesOfType('unsubscribe')).toEqual([{ type: 'unsubscribe', sessionId: SESSION_ID }]);
    expect(socket.framesOfType('subscribe')).toEqual([
      { type: 'subscribe', sessionId: SESSION_ID },
      { type: 'subscribe', sessionId: 99 },
    ]);
    h.ctl.destroy();
  });

  it('phase 变更透传给宿主 onEvent', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    socket.emit({ type: 'session_status', sessionId: SESSION_ID, data: { phase: 'RUNNING', executionId: 'e1' } });
    await nextTick();
    expect(h.events).toContainEqual({ type: 'phase', phase: 'RUNNING', sessionId: SESSION_ID });
    h.ctl.destroy();
  });
});
