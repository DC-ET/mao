import { describe, expect, it } from 'vitest';
import { FeishuAskFormStore } from './ask-form-store.js';
import { createFeishuPatchedProgress } from './patched-progress.js';
import { buildFeishuProgressCard, type FeishuSubagentSummary } from './progress-card.js';

const question = {
  question: '选哪个？',
  header: '方案',
  multiSelect: false,
  options: [{ label: '甲', description: '说明甲' }, { label: '乙', description: '说明乙' }],
};

function progressOf(
  store: FeishuAskFormStore,
  patch: (card: Record<string, unknown>) => Promise<void>,
  throttleMs = 0,
  options: { loadSubagents?: () => Promise<FeishuSubagentSummary[]>; now?: () => number } = {},
) {
  return createFeishuPatchedProgress({
    listAsks: () => store.list(1),
    clearAsks: () => store.clearSession(1),
    patch,
    buildCard: ({ status, round, content, tools, subagents, pendingAsks, elapsedMs, disliked }) => buildFeishuProgressCard(
      status, round, content, tools, { sessionId: 1, sender: 'ou_sender' }, elapsedMs, undefined, pendingAsks, disliked, subagents,
    ),
    loadSubagents: options.loadSubagents,
    startedAtMs: 0,
    now: options.now ?? (() => 1_000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    throttleMs,
  });
}

function dislikeButtonOf(card: Record<string, unknown>): { text?: { content?: string }; type?: string } | undefined {
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  return elements
    .flatMap((element) => (element.columns as Array<{ elements: Array<Record<string, unknown>> }> | undefined)?.flatMap((column) => column.elements) ?? [])
    .find((element) => (element.value as { act?: string })?.act === 'dislike') as never;
}

describe('飞书进度卡覆盖顺序', () => {
  it('表单状态清空之后的 update 不再包含该 requestId', async () => {
    const store = new FeishuAskFormStore();
    store.set(1, 'req-1', [question], 'ou_sender');
    const cards: string[] = [];
    const progress = progressOf(store, async (card) => { cards.push(JSON.stringify(card)); });
    await progress.update('RUNNING', 1, '执行中', []);
    expect(cards[0]).toContain('req-1');
    store.remove(1, 'req-1');
    await progress.update('RUNNING', 2, '继续', []);
    expect(cards[1]).not.toContain('req-1');
    expect(store.list(1)).toEqual([]);
  });

  it('节流等待期间登记的提问会在真正 PATCH 时带上', async () => {
    const store = new FeishuAskFormStore();
    const cards: string[] = [];
    const progress = progressOf(store, async (card) => { cards.push(JSON.stringify(card)); }, 40);
    await progress.update('RUNNING', 1, '先发出', []);
    const pending = progress.update('RUNNING', 2, '排队中', []);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.set(1, 'req-late', [question], 'ou_sender');
    await pending;
    expect(cards[0]).not.toContain('req-late');
    expect(cards[1]).toContain('req-late');
  });

  it('已发出的 PATCH 仍带表单时，结束后按最新快照补一次', async () => {
    const store = new FeishuAskFormStore();
    store.set(1, 'req-1', [question], 'ou_sender');
    const cards: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const progress = progressOf(store, async (card) => {
      cards.push(JSON.stringify(card));
      if (cards.length === 1) {
        started();
        await gate;
      }
    });
    const pending = progress.update('RUNNING', 1, '执行中', []);
    await startedGate;
    store.remove(1, 'req-1');
    release();
    await pending;
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards[0]).toContain('req-1');
    expect(cards.at(-1)).not.toContain('req-1');
  });

  it('终态更新清掉表单状态且卡片不含 requestId', async () => {
    const store = new FeishuAskFormStore();
    store.set(1, 'req-1', [question], 'ou_sender');
    const cards: string[] = [];
    const progress = progressOf(store, async (card) => { cards.push(JSON.stringify(card)); });
    await progress.update('CANCELLED', 1, '任务已取消。', []);
    expect(store.list(1)).toEqual([]);
    expect(cards[0]).not.toContain('req-1');
    expect(progress.isRunning()).toBe(false);
  });
});

describe('飞书进度卡点踩态透传', () => {
  it('setDisliked 后终态卡片按钮变为红色「已点踩 · 再点取消」', async () => {
    const cards: Array<Record<string, unknown>> = [];
    const progress = progressOf(new FeishuAskFormStore(), async (card) => { cards.push(card); });
    await progress.update('COMPLETED', 1, '结果', []);
    expect(dislikeButtonOf(cards[0])?.type).toBe('default');
    progress.setDisliked(true);
    // renderCurrent 供回调立即返回，必须反映最新点踩态
    expect(dislikeButtonOf(progress.renderCurrent())?.text?.content).toBe('👎 已点踩 · 再点取消');
    // 后续 PATCH（同会话新任务重画卡片时）同样带点踩态
    await progress.update('COMPLETED', 1, '结果', []);
    expect(dislikeButtonOf(cards.at(-1) as Record<string, unknown>)?.text?.content).toBe('👎 已点踩 · 再点取消');
  });

  it('取消点踩后卡片恢复中性灰', async () => {
    const cards: Array<Record<string, unknown>> = [];
    const progress = progressOf(new FeishuAskFormStore(), async (card) => { cards.push(card); });
    await progress.update('COMPLETED', 1, '结果', []);
    progress.setDisliked(true);
    progress.setDisliked(false);
    expect(dislikeButtonOf(progress.renderCurrent())?.type).toBe('default');
    await progress.update('COMPLETED', 1, '结果', []);
    expect(dislikeButtonOf(cards.at(-1) as Record<string, unknown>)?.text?.content).toBe('👎 不满意');
  });

  it('RUNNING 态不渲染点踩按钮', () => {
    const progress = progressOf(new FeishuAskFormStore(), async () => undefined);
    expect(dislikeButtonOf(progress.renderCurrent())).toBeUndefined();
  });

  it('终态耗用在进入终态时固化，点踩回调不会把「耗时」越拉越长', async () => {
    let clock = 506_000;
    const store = new FeishuAskFormStore();
    const cards: Array<Record<string, unknown>> = [];
    const progress = createFeishuPatchedProgress({
      listAsks: () => store.list(1),
      clearAsks: () => store.clearSession(1),
      patch: async (card) => { cards.push(card); },
      buildCard: ({ status, round, content, tools, elapsedMs, disliked }) => buildFeishuProgressCard(
        status, round, content, tools, { sessionId: 1, sender: 'ou_sender' }, elapsedMs, undefined, undefined, disliked,
      ),
      startedAtMs: 0,
      now: () => clock,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      throttleMs: 0,
    });
    await progress.update('COMPLETED', 8, '结果', []);
    const atCompletion = JSON.stringify(progress.renderCurrent());
    expect(atCompletion).toContain('耗时 8 分 26 秒');

    // 10 分钟后用户才点「不满意」：回调卡片必须仍是完成那一刻的耗时
    clock += 600_000;
    progress.setDisliked(true);
    const afterDislike = JSON.stringify(progress.renderCurrent());
    expect(afterDislike).toContain('耗时 8 分 26 秒');
    expect(afterDislike).not.toContain('18 分');
    expect(afterDislike).toContain('👎 已点踩 · 再点取消');
  });

  it('RUNNING 态 renderCurrent 仍按当前时刻算（不展示耗时）', () => {
    const progress = progressOf(new FeishuAskFormStore(), async () => undefined);
    expect(JSON.stringify(progress.renderCurrent())).not.toContain('耗时');
  });
});

describe('飞书进度卡运行中子代理', () => {
  const subagents: FeishuSubagentSummary[] = [
    { taskId: 1, agentType: 'explorer', title: '排查卡片进度链路', status: 'RUNNING', round: 2 },
  ];

  it('update 前加载并渲染运行中子代理', async () => {
    const cards: Array<Record<string, unknown>> = [];
    const progress = progressOf(new FeishuAskFormStore(), async (card) => { cards.push(card); }, 0, {
      loadSubagents: async () => subagents,
    });
    await progress.update('RUNNING', 1, '正文', []);
    expect(JSON.stringify(cards[0])).toContain('调研 · 排查卡片进度链路 · 第 2 轮');
  });

  it('1s 内连续 update 复用快照，refresh 强制重新加载', async () => {
    let clock = 1_000;
    let loads = 0;
    const progress = progressOf(new FeishuAskFormStore(), async () => undefined, 0, {
      loadSubagents: async () => { loads++; return subagents; },
      now: () => clock,
    });
    await progress.update('RUNNING', 1, '一', []);
    await progress.update('RUNNING', 2, '二', []);
    expect(loads).toBe(1);
    await progress.refresh();
    expect(loads).toBe(2);
    clock += 1_001;
    await progress.update('RUNNING', 3, '三', []);
    expect(loads).toBe(3);
  });

  it('加载失败保留上次快照，卡片仍更新', async () => {
    let fail = false;
    let clock = 0;
    const cards: Array<Record<string, unknown>> = [];
    const progress = progressOf(new FeishuAskFormStore(), async (card) => { cards.push(card); }, 0, {
      loadSubagents: async () => {
        if (fail) throw new Error('db down');
        return subagents;
      },
      now: () => clock,
    });
    clock = 2_000;
    await progress.update('RUNNING', 1, '一', []);
    fail = true;
    clock = 4_000;
    await progress.update('RUNNING', 2, '二', []);
    expect(JSON.stringify(cards[1])).toContain('调研 · 排查卡片进度链路');
  });

  it('renderCurrent 使用缓存，不重新加载', async () => {
    let loads = 0;
    const progress = progressOf(new FeishuAskFormStore(), async () => undefined, 0, {
      loadSubagents: async () => { loads++; return subagents; },
    });
    await progress.update('RUNNING', 1, '正文', []);
    const before = loads;
    const card = progress.renderCurrent();
    expect(loads).toBe(before);
    expect(JSON.stringify(card)).toContain('调研 · 排查卡片进度链路');
  });

  it('终态清空子代理，renderCurrent 也不携带', async () => {
    const cards: Array<Record<string, unknown>> = [];
    const progress = progressOf(new FeishuAskFormStore(), async (card) => { cards.push(card); }, 0, {
      loadSubagents: async () => subagents,
    });
    await progress.update('RUNNING', 1, '正文', []);
    await progress.update('COMPLETED', 1, '完成', []);
    expect(JSON.stringify(cards.at(-1))).not.toContain('调研');
    expect(JSON.stringify(progress.renderCurrent())).not.toContain('调研');
  });
});
