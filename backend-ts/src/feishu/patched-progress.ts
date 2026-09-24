import type { FeishuCardStatus } from './progress-card.js';
import type { FeishuPendingAsk } from './ask-form-store.js';

export interface FeishuProgressSnapshot {
  status: FeishuCardStatus;
  round: number;
  content: string;
  tools: string[];
}

export interface FeishuProgressHandle {
  isRunning(): boolean;
  /** 用最近一次快照再刷一张卡；节流排队，PATCH 前重读表单状态。 */
  refresh(): Promise<void>;
  /** 同步按当前表单状态渲染最近快照，供卡片回调立即返回，不得等待 PATCH。 */
  renderCurrent(): Record<string, unknown>;
}

const DEFAULT_THROTTLE_MS = 250;

/**
 * 进度卡 PATCH 闭包。
 * 节流等待结束、真正发出 PATCH 之前才读取表单列表，这样工具开始时排队的更新只要发生在登记之后就会带上表单。
 * 每次 PATCH 结束后再读一遍：若等待期间表单被清掉（用户已提交，或更早的快照仍带表单），补一次不含该表单的 PATCH。
 */
export function createFeishuPatchedProgress(deps: {
  listAsks: () => FeishuPendingAsk[];
  /** 终态更新时清掉本会话表单，避免随后的 RUNNING 快照把已结束的提问再画上去。 */
  clearAsks: () => void;
  patch: (card: Record<string, unknown>) => Promise<void>;
  /** 本次 PATCH 成功后的提问列表。空列表表示这张卡上已经没有待回答的题。 */
  afterPatch?: (pendingAsks: FeishuPendingAsk[]) => void;
  buildCard: (input: FeishuProgressSnapshot & { pendingAsks: FeishuPendingAsk[]; elapsedMs?: number }) => Record<string, unknown>;
  startedAtMs: number;
  seed?: FeishuProgressSnapshot;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  throttleMs?: number;
}): FeishuProgressHandle & {
  update(status: FeishuCardStatus, round: number, content: string, tools: string[]): Promise<void>;
} {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  let nextUpdateAt = 0;
  let chain: Promise<void> = Promise.resolve();
  let last: FeishuProgressSnapshot = deps.seed ?? { status: 'RUNNING', round: 0, content: '', tools: [] };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(async () => {
      const wait = nextUpdateAt - now();
      if (wait > 0) await sleep(wait);
      nextUpdateAt = now() + throttleMs;
      await task();
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const send = async (status: FeishuCardStatus, round: number, content: string, tools: string[]): Promise<void> => {
    if (status !== 'RUNNING') deps.clearAsks();
    const elapsedMs = status === 'RUNNING' ? undefined : Math.max(0, now() - deps.startedAtMs);
    const asksNow = (): FeishuPendingAsk[] => (status === 'RUNNING' ? deps.listAsks() : []);
    const build = (pendingAsks: FeishuPendingAsk[]): Record<string, unknown> => deps.buildCard({
      status, round, content, tools, pendingAsks, elapsedMs,
    });
    last = { status, round, content, tools };
    const card = build(asksNow());
    await deps.patch(card);
    const latestAsks = asksNow();
    const latest = build(latestAsks);
    if (JSON.stringify(latest) !== JSON.stringify(card)) {
      await deps.patch(latest);
    }
    deps.afterPatch?.(latestAsks);
  };

  return {
    update(status, round, content, tools) {
      return enqueue(() => send(status, round, content, tools));
    },
    refresh() {
      return enqueue(async () => {
        if (last.status !== 'RUNNING') return;
        await send(last.status, last.round, last.content, last.tools);
      });
    },
    renderCurrent() {
      const pendingAsks = last.status === 'RUNNING' ? deps.listAsks() : [];
      const elapsedMs = last.status === 'RUNNING' ? undefined : Math.max(0, now() - deps.startedAtMs);
      return deps.buildCard({ ...last, pendingAsks, elapsedMs });
    },
    isRunning() {
      return last.status === 'RUNNING';
    },
  };
}
