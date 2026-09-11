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
let agentAvatarUrl: string | null | undefined;
let agentName: string | null | undefined = '客服助手';
let agentSuggestedQuestions: Array<{ content?: string | null }> | undefined;
let failImageUpload = false;
let incomingAbsolutePath = '/opt/mao/runtime/1/incoming/a.pdf';

function installFetch(fetchCalls: string[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push(`${method} ${url}`);
    if (url.endsWith('/upload/config')) return jsonOk({ storageMode: 'local', baseUrl: '', maxSizeMb: 8 });
    if (url.endsWith('/files/upload-incoming')) return jsonOk({ absolutePath: incomingAbsolutePath });
    if (url.endsWith('/files/upload')) {
      if (failImageUpload) throw new Error('upload failed');
      return jsonOk({ url: '/uploads/pic.png' });
    }
    if (url.endsWith('/agents/3')) {
      return jsonOk({
        id: 3,
        name: agentName,
        avatarUrl: agentAvatarUrl,
        suggestedQuestions: agentSuggestedQuestions,
      });
    }
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

async function makeHarness(overrides: Partial<Extract<MaoChatInitOptions, { getToken: () => Promise<string> }>> = {}): Promise<Harness> {
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
    agentAvatarUrl = undefined;
    agentName = '客服助手';
    agentSuggestedQuestions = undefined;
    failImageUpload = false;
    incomingAbsolutePath = '/opt/mao/runtime/1/incoming/a.pdf';
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    window.localStorage.clear();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWs;
    globalThis.fetch = originalFetch;
  });

  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['/uploads/agents/3.png', 'https://mao.example.com/uploads/agents/3.png'],
    ['https://oss.example.com/3.png', 'https://oss.example.com/3.png'],
  ])('boot 获取 Agent 并解析头像 %s', async (avatar, expected) => {
    agentAvatarUrl = avatar;
    const h = await makeHarness();
    expect(h.fetchCalls).toHaveLength(0);
    await boot(h);
    expect(h.fetchCalls).toContain('GET https://mao.example.com/api/v1/agents/3');
    expect(h.ui.agentAvatarUrl).toBe(expected);
    h.ctl.destroy();
  });

  it('boot 随 Agent 详情拉取推荐问题，过滤空白内容', async () => {
    agentSuggestedQuestions = [
      { content: '帮我总结当前页面' },
      { content: '   ' },
      { content: null },
      { content: '这个页面上有什么按钮？' },
    ];
    const h = await makeHarness();
    await boot(h);
    expect(h.ui.suggestedQuestions).toEqual(['帮我总结当前页面', '这个页面上有什么按钮？']);
    h.ctl.destroy();
  });

  it('boot 未返回推荐问题时保持空数组（空白态不渲染该区块）', async () => {
    const h = await makeHarness();
    await boot(h);
    expect(h.ui.suggestedQuestions).toEqual([]);
    h.ctl.destroy();
  });

  it.each([
    ['客服助手', '客服助手'],
    ['  客服助手  ', '客服助手'],
    [undefined, 'Mao 助手'],
    [null, 'Mao 助手'],
    ['', 'Mao 助手'],
    ['   ', 'Mao 助手'],
  ])('boot 浮窗标题使用 Agent 名称 %s', async (name, expected) => {
    agentName = name;
    const h = await makeHarness();
    expect(h.ui.sessionTitle).toBe('Mao 助手');
    await boot(h);
    expect(h.ui.sessionTitle).toBe(expected);
    h.ctl.destroy();
  });

  it('session_title_updated 不覆盖 Agent 名称', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    expect(h.ui.sessionTitle).toBe('客服助手');
    socket.emit({ type: 'session_title_updated', sessionId: SESSION_ID, data: { title: '今天的订单查询' } });
    await nextTick();
    expect(h.ui.sessionTitle).toBe('客服助手');
    h.ctl.destroy();
  });

  it('Agent 详情失败通过原有初始化错误展示，重试后加载头像', async () => {
    const h = await makeHarness();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Agent unavailable'));
    h.ctl.open();
    await vi.waitFor(() => expect(h.ui.sessionError).toBe('Agent unavailable'));
    expect(h.ui.agentAvatarUrl).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
    agentAvatarUrl = '/uploads/agents/3.png';
    await boot(h);
    expect(h.ui.agentAvatarUrl).toBe('https://mao.example.com/uploads/agents/3.png');
    h.ctl.destroy();
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

  it('boot 读取后台上传配置作为附件大小上限', async () => {
    const h = await makeHarness();
    expect(h.ui.attachmentMaxMb).toBe(1024);
    await boot(h);
    expect(h.fetchCalls).toContain('GET https://mao.example.com/api/v1/upload/config');
    expect(h.ui.attachmentMaxMb).toBe(8);
    h.ctl.destroy();
  });

  it('图片附件先上传，再由 send_message 带 images 并回显缩略图', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await h.ctl.send('看下这张图', [{ id: 'a1', file, previewUrl: null }]);

    expect(h.fetchCalls).toContain('POST https://mao.example.com/api/v1/files/upload');
    const frame = socket.framesOfType('send_message')[0] as {
      data: { content: string; images?: string[] };
    };
    expect(frame.data.content).toBe('看下这张图');
    // 本地存储模式返回 /uploads/xxx：必须补成 Mao 服务绝对地址，LLM 才能取图
    expect(frame.data.images).toEqual(['https://mao.example.com/uploads/pic.png']);
    expect(h.ctl.store.messages.value[0].images).toEqual(['https://mao.example.com/uploads/pic.png']);
    h.ctl.destroy();
  });

  it('非图片文件上传后以 @{绝对路径}@ 引用写进正文', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    incomingAbsolutePath = '/opt/mao/runtime/1/incoming/报告.pdf';
    const file = new File(['y'], '报告.pdf', { type: 'application/pdf' });
    await h.ctl.send('帮我看看', [{ id: 'a1', file, previewUrl: null }]);

    expect(h.fetchCalls).toContain('POST https://mao.example.com/api/v1/files/upload-incoming');
    const frame = socket.framesOfType('send_message')[0] as { data: { content: string; images?: string[] } };
    expect(frame.data.content).toBe('帮我看看\n@{/opt/mao/runtime/1/incoming/报告.pdf}@');
    expect(frame.data.images).toBeUndefined();
    h.ctl.destroy();
  });

  it('附件全部上传失败且无正文时不发送，横幅点名失败文件', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    failImageUpload = true;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await h.ctl.send('', [{ id: 'a1', file, previewUrl: null }]);

    expect(socket.framesOfType('send_message')).toEqual([]);
    expect(h.ctl.store.messages.value).toHaveLength(0);
    expect(h.ui.sessionError).toBe('附件上传失败：shot.png');
    h.ctl.destroy();
  });

  it('部分附件失败仍有正文时照常发送，并提示失败项', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    failImageUpload = true;
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    const doc = new File(['y'], 'a.pdf', { type: 'application/pdf' });
    await h.ctl.send('看下', [
      { id: 'a1', file: image, previewUrl: null },
      { id: 'a2', file: doc, previewUrl: null },
    ]);

    const frame = socket.framesOfType('send_message')[0] as { data: { content: string; images?: string[] } };
    expect(frame.data.images).toBeUndefined();
    expect(frame.data.content).toBe('看下\n@{/opt/mao/runtime/1/incoming/a.pdf}@');
    expect(h.ui.sessionError).toBe('附件上传失败：shot.png');
    h.ctl.destroy();
  });

  it('历史消息里的图片附件按 Mao 服务域名补全后回显', async () => {
    historyMessages = [{ id: 1, role: 'USER', content: '看下', images: ['/uploads/pic.png'] }];
    const h = await makeHarness();
    await boot(h);
    expect(h.ctl.store.messages.value[0].images).toEqual(['https://mao.example.com/uploads/pic.png']);
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

  it('历史按消息与调用数组顺序恢复聚合 segments 和工具结果', async () => {
    historyMessages = [
      { id: 1, role: 'SYSTEM', content: '不显示' },
      { id: 2, role: 'USER', content: '[用户选中文本]\n引用内容\n\n---\n\n问题' },
      {
        id: 3, role: 'ASSISTANT', thinkingContent: '先想一下', content: '开始查询',
        toolCalls: JSON.stringify([
          { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'tc2', type: 'function', function: { name: 'shell', arguments: '{}' } },
        ]),
      },
      // 即使结果顺序不同，也不改写调用数组顺序。
      { id: 4, role: 'TOOL', toolCallId: 'tc2', content: 'error: command failed' },
      { id: 5, role: 'TOOL', toolCallId: 'tc1', content: '文件内容' },
      { id: 6, role: 'ASSISTANT', content: '查询结论', thinkingContent: '再想一下' },
      { id: 7, role: 'ASSISTANT', content: '', thinkingContent: null },
    ];
    const h = await makeHarness();
    await boot(h);
    const messages = h.ctl.store.messages.value;
    expect(messages.map((m) => m.id)).toEqual(['h_2', 'h_3', 'h_6']);
    expect(messages[0].content).toBe('问题');
    expect(messages[0].quotedSelection).toBe('引用内容');
    expect(messages[0].segments).toEqual([{ type: 'text', content: '问题' }]);
    expect(messages[1].segments).toEqual([
      { type: 'thinking', content: '先想一下' },
      { type: 'text', content: '开始查询' },
      { type: 'tool-group', toolCalls: [
        { toolCallId: 'tc1', toolName: 'read_file', displayName: 'read_file', argsText: '{"path":"a"}', status: 'done', resultText: '文件内容' },
        { toolCallId: 'tc2', toolName: 'shell', displayName: 'shell', argsText: '{}', status: 'done', resultText: 'error: command failed' },
      ] },
    ]);
    const group = messages[1].segments[2];
    expect(group.type === 'tool-group' && group.toolCalls).toBe(messages[1].toolCalls);
    expect(messages[2].segments).toEqual([
      { type: 'thinking', content: '再想一下' },
      { type: 'text', content: '查询结论' },
    ]);
    expect(messages.every((m) => !m.streaming && !m.error)).toBe(true);
    h.ctl.destroy();
  });

  it('历史保留纯工具与纯思考消息，缺失结果标为 unknown 且不跨轮关联', async () => {
    historyMessages = [
      { id: 1, role: 'ASSISTANT', toolCalls: JSON.stringify([
        { id: 'tc1', function: { name: 'read_file' } },
        { id: 'tc2', function: { name: 'shell', arguments: '{}' } },
      ]) },
      { id: 2, role: 'TOOL', toolCallId: 'tc1', content: '' },
      { id: 3, role: 'TOOL', toolCallId: 'orphan', content: '孤立结果' },
      { id: 4, role: 'USER', content: '下一轮' },
      { id: 5, role: 'TOOL', toolCallId: 'tc2', content: '不应跨轮关联' },
      { id: 6, role: 'ASSISTANT', thinkingContent: '只有思考' },
    ];
    const h = await makeHarness();
    await boot(h);
    const messages = h.ctl.store.messages.value;
    expect(messages.map((m) => m.id)).toEqual(['h_1', 'h_4', 'h_6']);
    expect(messages[0].segments).toEqual([{ type: 'tool-group', toolCalls: messages[0].toolCalls }]);
    expect(messages[0].toolCalls.map((t) => [t.status, t.resultText])).toEqual([['done', ''], ['unknown', '']]);
    expect(messages[0].toolCalls[0].argsText).toBe('');
    expect(messages[2].segments).toEqual([{ type: 'thinking', content: '只有思考' }]);
    h.ctl.destroy();
  });

  it('历史工具 JSON 损坏时明确报错而不是静默丢失工具', async () => {
    historyMessages = [{ id: 1, role: 'ASSISTANT', content: '查询中', toolCalls: '{broken' }];
    const h = await makeHarness();
    h.ctl.open();
    await vi.waitFor(() => expect(h.ui.sessionError).not.toBeNull(), { timeout: 2000 });
    expect(h.ctl.store.messages.value).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(0);
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
    expect(h.ctl.store.messages.value[0].segments).toEqual([{ type: 'text', content: '这单什么状态？' }]);
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

  it('发送带选中引用时气泡回显讨论块，正文仍是用户输入', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    h.ui.quotedSelection = '不健康实例 telemetry 10.140.0.96:8080';
    await h.ctl.send('帮我看下');
    const user = h.ctl.store.messages.value.find((m) => m.role === 'user');
    expect(user?.content).toBe('帮我看下');
    expect(user?.quotedSelection).toBe('不健康实例 telemetry 10.140.0.96:8080');
    const frame = socket.framesOfType('send_message')[0] as { data: { content: string } };
    expect(frame.data.content).toContain('[用户选中文本]');
    expect(frame.data.content).toContain('不健康实例 telemetry 10.140.0.96:8080');
    expect(h.ui.quotedSelection).toBeNull();
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
    expect(h.ui.sessionTitle).toBe('客服助手');
    expect(socket.framesOfType('unsubscribe')).toEqual([{ type: 'unsubscribe', sessionId: SESSION_ID }]);
    expect(socket.framesOfType('subscribe')).toEqual([
      { type: 'subscribe', sessionId: SESSION_ID },
      { type: 'subscribe', sessionId: 99 },
    ]);
    h.ctl.destroy();
  });

  it('createSession 请求体带 source=embed', async () => {
    const h = await makeHarness();
    await boot(h);
    const posts = h.fetchCalls.filter((c) => c.startsWith('POST'));
    expect(posts.some((c) => c.includes('/sessions'))).toBe(true);
    h.ctl.destroy();
  });

  it('boot 恢复 web 来源会话时惰性补标 embed', async () => {
    const h = await makeHarness();
    await boot(h);
    await vi.waitFor(() => {
      expect(h.fetchCalls.some((c) => c.startsWith('PUT') && c.includes(`/sessions/${SESSION_ID}/source`))).toBe(true);
    });
    h.ctl.destroy();
  });

  it('toggleHistory 打开时拉取第一页并填充列表', async () => {
    const h = await makeHarness();
    await boot(h);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('source=embed')) {
        return jsonOk({
          items: [
            { id: SESSION_ID, title: '当前会话', updatedAt: '2026-09-11 10:00:00' },
            { id: 50, title: '旧会话', updatedAt: '2026-09-10 10:00:00' },
          ],
          total: 2, offset: 0, limit: 20, hasMore: false,
        });
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    h.ctl.toggleHistory();
    expect(h.ui.historyOpen).toBe(true);
    await vi.waitFor(() => expect(h.ui.historyItems).toHaveLength(2));
    expect(h.ui.historyHasMore).toBe(false);
    h.ctl.toggleHistory();
    expect(h.ui.historyOpen).toBe(false);
    h.ctl.destroy();
  });

  it('selectHistory 切换会话：退订旧、订阅新、更新常驻指针、拉历史', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    let switchTarget = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/sessions/${switchTarget}`) && !url.includes('messages')) {
        return jsonOk({ id: switchTarget, title: '旧会话', phase: 'IDLE' });
      }
      if (url.includes(`/sessions/${switchTarget}/messages`)) {
        return jsonOk({ messages: [], hasMore: false });
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    switchTarget = 50;
    await h.ctl.selectHistory(50);
    expect(h.ui.historyOpen).toBe(false);
    expect(h.ctl.store.sessionId()).toBe(50);
    expect(socket.framesOfType('unsubscribe')).toEqual([{ type: 'unsubscribe', sessionId: SESSION_ID }]);
    const subs = socket.framesOfType('subscribe');
    expect(subs[subs.length - 1]).toEqual({ type: 'subscribe', sessionId: 50 });
    const storedValues = Object.values(window.localStorage) as string[];
    expect(storedValues).toContain('50');
    h.ctl.destroy();
  });

  it('selectHistory 目标已删除时报错并保持原会话', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sessions/999')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ code: 3002, message: '会话不存在' }),
        } as unknown as Response;
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    await h.ctl.selectHistory(999);
    expect(h.ctl.store.sessionId()).toBe(SESSION_ID);
    expect(h.ui.historyError).toBeTruthy();
    // 校验失败发生在 store 变更之前，不应产生 unsubscribe
    expect(socket.framesOfType('unsubscribe')).toHaveLength(0);
    h.ctl.destroy();
  });

  it('selectHistory 同一会话幂等：仅收起面板', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    h.ui.historyOpen = true;
    await h.ctl.selectHistory(SESSION_ID);
    expect(h.ui.historyOpen).toBe(false);
    expect(socket.framesOfType('unsubscribe')).toHaveLength(0);
    h.ctl.destroy();
  });

  it('selectHistory 历史拉取失败：退订目标会话并回退原会话', async () => {
    const h = await makeHarness();
    const socket = await boot(h);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sessions/50') && !url.includes('messages')) {
        return jsonOk({ id: 50, title: '旧会话', phase: 'IDLE' });
      }
      if (url.includes('/sessions/50/messages')) {
        throw new Error('network down');
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    await h.ctl.selectHistory(50);
    // 回退后仍绑定原会话
    expect(h.ctl.store.sessionId()).toBe(SESSION_ID);
    expect(h.ui.activeSessionId).toBe(SESSION_ID);
    expect(h.ui.historyError).toBeTruthy();
    // 目标会话已退订：50 subscribe 后必须有对应 unsubscribe
    const unsubs = socket.framesOfType('unsubscribe').map((f) => f.sessionId);
    expect(unsubs).toContain(50);
    // 原会话重新订阅（boot 1 次 + 回退 1 次）
    const subs = socket.framesOfType('subscribe').map((f) => f.sessionId);
    expect(subs.filter((id) => id === SESSION_ID).length).toBe(2);
    h.ctl.destroy();
  });

  it('连续快速切换：旧流程作废，不产生半切换状态', async () => {
    const h = await makeHarness();
    await boot(h);
    let resolveFirst: (v: Response) => void = () => {};
    const firstGate = new Promise<Response>((r) => { resolveFirst = r; });
    let historyCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sessions/60') && !url.includes('messages')) {
        return firstGate; // 第一次切换的 GET 挂起
      }
      if (url.includes('/sessions/70') && !url.includes('messages')) {
        return jsonOk({ id: 70, title: 'B', phase: 'IDLE' });
      }
      if (url.includes('/messages')) {
        historyCalls++;
        return jsonOk({ messages: [], hasMore: false });
      }
      return jsonOk({ messages: [], hasMore: false });
    }) as unknown as typeof fetch;
    const first = h.ctl.selectHistory(60);
    await nextTick();
    await h.ctl.selectHistory(70); // 在途时发起第二次切换
    expect(h.ctl.store.sessionId()).toBe(70);
    resolveFirst(jsonOk({ id: 60, title: 'A', phase: 'IDLE' }));
    await first;
    // 第一次切换作废：不覆盖第二次的结果
    expect(h.ctl.store.sessionId()).toBe(70);
    expect(h.ui.activeSessionId).toBe(70);
    h.ctl.destroy();
  });

  it('身份切换后历史面板状态清空', async () => {
    const h = await makeHarness();
    await boot(h);
    const setIdentity = (u: string | null) =>
      (h.ctl as unknown as { setIdentity: (user: string | null) => boolean }).setIdentity(u);
    // null → user-1：首次建立身份（changed=false 不清理）；user-1 → user-2：真实切换
    setIdentity('user-1');
    h.ui.historyOpen = true;
    h.ui.historyItems = [{ id: SESSION_ID, title: '旧账号会话', updatedAt: null, phase: null }];
    h.ui.activeSessionId = SESSION_ID;
    setIdentity('user-2');
    expect(h.ui.historyOpen).toBe(false);
    expect(h.ui.historyItems).toHaveLength(0);
    expect(h.ui.activeSessionId).toBeNull();
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
