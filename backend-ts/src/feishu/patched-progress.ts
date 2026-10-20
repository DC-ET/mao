import type { FeishuCardStatus, FeishuSubagentSummary } from './progress-card.js';
import type { FeishuPendingAsk } from './ask-form-store.js';

export interface FeishuProgressSnapshot {
  status: FeishuCardStatus;
  round: number;
  content: string;
  tools: string[];
  /** 运行中的后台子代理；仅 RUNNING 快照携带，终态清空。 */
  subagents?: FeishuSubagentSummary[];
}

export interface FeishuProgressHandle {
  isRunning(): boolean;
  /** 用最近一次快照再刷一张卡；节流排队，PATCH 前重读表单状态。 */
  refresh(): Promise<void>;
  /** 同步按当前表单状态渲染最近快照，供卡片回调立即返回，不得等待 PATCH。 */
  renderCurrent(): Record<string, unknown>;
  /** 记录完成卡点踩态（以 message_feedback 表为准的查询结果），后续 PATCH 与 renderCurrent 按该态渲染按钮。 */
  setDisliked(disliked: boolean): void;
}

const DEFAULT_THROTTLE_MS = 250;

/** 运行中子代理查询缓存：避免工具参数流高频更新时重复查库。 */
const SUBAGENT_CACHE_MS = 1000;

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
  buildCard: (input: FeishuProgressSnapshot & { pendingAsks: FeishuPendingAsk[]; elapsedMs?: number; disliked?: boolean }) => Record<string, unknown>;
  /** 运行中子代理加载器；失败时保留上次快照，不影响卡片更新。 */
  loadSubagents?: () => Promise<FeishuSubagentSummary[]>;
  /**
   * 终态快照持久化（D9）：COMPLETED 真正 PATCH 前 await，避免「卡已更新、快照未落」的点击竞态。
   * 失败仅 warn 不阻断 PATCH；轮次/耗时取终态固化值，正文与卡片同口径。
   */
  persistTerminal?: (snapshot: { round: number; content: string; elapsedMs?: number }) => Promise<void>;
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
  let disliked = false;
  // 终态耗用在进入终态那一刻固化：renderCurrent 若按调用时刻重算，卡片挂多久耗时就涨多久
  // （飞书完成卡长期挂着，用户几分钟后点踩会看到「耗时」被凭空拉长）。
  let terminalElapsedMs: number | undefined;
  let last: FeishuProgressSnapshot = deps.seed ?? { status: 'RUNNING', round: 0, content: '', tools: [] };
  let lastSubagents: FeishuSubagentSummary[] = deps.seed?.subagents ?? [];
  let lastSubagentsAt = 0;
  let lastSubagentsLoaded = false;

  /** 加载运行中子代理；失败保留上次快照，1s 内复用，refresh 时可强制刷新。 */
  const loadSubagents = async (force: boolean): Promise<FeishuSubagentSummary[]> => {
    if (deps.loadSubagents == null) return [];
    if (!force && lastSubagentsLoaded && now() - lastSubagentsAt < SUBAGENT_CACHE_MS) {
      return lastSubagents;
    }
    try {
      lastSubagents = await deps.loadSubagents();
    } catch (e) {
      console.warn(`飞书进度卡加载运行中子代理失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    lastSubagentsAt = now();
    lastSubagentsLoaded = true;
    return lastSubagents;
  };

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

  const send = async (
    status: FeishuCardStatus, round: number, content: string, tools: string[],
    forceSubagents = false,
  ): Promise<void> => {
    // 终态卡片不展示子代理，同时清空快照，避免后续 renderCurrent 把运行中列表带进终态卡。
    lastSubagents = status === 'RUNNING' ? await loadSubagents(forceSubagents) : [];
    if (status !== 'RUNNING') {
      deps.clearAsks();
      terminalElapsedMs = Math.max(0, now() - deps.startedAtMs);
    }
    const elapsedMs = status === 'RUNNING' ? undefined : terminalElapsedMs;
    const asksNow = (): FeishuPendingAsk[] => (status === 'RUNNING' ? deps.listAsks() : []);
    const build = (pendingAsks: FeishuPendingAsk[]): Record<string, unknown> => deps.buildCard({
      status, round, content, tools, subagents: lastSubagents, pendingAsks, elapsedMs, disliked,
    });
    last = { status, round, content, tools, subagents: lastSubagents };
    const card = build(asksNow());
    // D9：终态快照先落库再 PATCH。失败仅 warn——快照缺失只让该卡点击退化为兜底路径，不能卡住终态更新。
    if (status === 'COMPLETED' && deps.persistTerminal != null) {
      try {
        await deps.persistTerminal({ round, content, elapsedMs: terminalElapsedMs });
      } catch (e) {
        console.warn(`飞书完成卡终态快照持久化失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await deps.patch(card);
    const latest = build(asksNow());
    if (JSON.stringify(latest) !== JSON.stringify(card)) {
      await deps.patch(latest);
    }
  };

  return {
    update(status, round, content, tools) {
      return enqueue(() => send(status, round, content, tools));
    },
    refresh() {
      return enqueue(async () => {
        if (last.status !== 'RUNNING') return;
        await send(last.status, last.round, last.content, last.tools, true);
      });
    },
    renderCurrent() {
      const pendingAsks = last.status === 'RUNNING' ? deps.listAsks() : [];
      const elapsedMs = last.status === 'RUNNING' ? undefined : terminalElapsedMs;
      return deps.buildCard({ ...last, subagents: last.subagents ?? [], pendingAsks, elapsedMs, disliked });
    },
    setDisliked(value: boolean) {
      disliked = value;
    },
    isRunning() {
      return last.status === 'RUNNING';
    },
  };
}
