import { describe, expect, it } from 'vitest';
import { FeishuAskFormStore } from './ask-form-store.js';
import { createFeishuPatchedProgress } from './patched-progress.js';
import { buildFeishuProgressCard } from './progress-card.js';

const question = {
  question: '选哪个？',
  header: '方案',
  multiSelect: false,
  options: [{ label: '甲', description: '说明甲' }, { label: '乙', description: '说明乙' }],
};

function progressOf(store: FeishuAskFormStore, patch: (card: Record<string, unknown>) => Promise<void>, throttleMs = 0) {
  return createFeishuPatchedProgress({
    listAsks: () => store.list(1),
    clearAsks: () => store.clearSession(1),
    patch,
    buildCard: ({ status, round, content, tools, pendingAsks, elapsedMs }) => buildFeishuProgressCard(
      status, round, content, tools, { sessionId: 1, sender: 'ou_sender' }, elapsedMs, undefined, pendingAsks,
    ),
    startedAtMs: 0,
    now: () => 1_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    throttleMs,
  });
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
