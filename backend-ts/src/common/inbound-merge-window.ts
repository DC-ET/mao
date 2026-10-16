/**
 * 入站消息防抖合并窗口（飞书 / 钉钉 / 微信共用）。
 *
 * 语义（固定窗口，非滑动）：
 * - 首条可合并消息进窗启动定时器，批内后续到达不延长窗口；定时器到点整批冲刷。
 * - 不可合并消息（媒体 / `---` / p2p 引用切换等）到达即冲刷同键在途批次，随后单独触发；
 *   豁免路径只等批次 flush「启动」（onFlush 已被调用），不等其执行完成——否则图片 ingest、
 *   `---` 取消会话会被在途批次的最长执行时间阻塞（相对现状是回退）。
 * - `windowMs <= 0` 时所有消息按豁免路径单条触发，行为与加窗之前完全一致（回退开关）。
 * - flush 幂等：定时器到点与豁免冲刷竞争时，缓冲条目在 flush 启动时即被取走，
 *   后到者看到空缓冲不会重复触发同一批。
 * - 单批 onFlush 抛错只记日志（由各端适配层负责 claim 收尾），键状态立即复位，
 *   不影响该键后续消息；`flushAll` 供关机时 best-effort 冲刷在途批次。
 */
export interface InboundMergeWindowOptions<E> {
  /** 窗口时长（ms）。<= 0 = 禁用：submit 直接单条触发，行为与现状一致。 */
  windowMs: number;
  /** 窗口键：账号 + 会话（+ 话题）+ 发送者。 */
  keyOf: (entry: E) => string;
  /** 批内去重键（飞书/钉钉 messageId；微信用 messageKey）；返回 null 不去重。 */
  dedupeKeyOf: (entry: E) => string | null;
  /** 准入：返回 false 的消息不并入窗口（先冲刷在途批，再单独触发）。 */
  canJoin: (entry: E) => boolean;
  /** 到达序号（process 入口同步分配）：flush 时批内按它排序，保证合并顺序 = 到达顺序。 */
  seqOf?: (entry: E) => number;
  /** 合并触发：批内条目已按到达有序；实现方负责合并与 claim 收尾。 */
  onFlush: (batch: E[]) => Promise<void>;
}

interface KeyState<E> {
  entries: E[];
  timer: NodeJS.Timeout | null;
  /** 最近一次 flush 的「已启动」Promise：豁免路径据此保证触发顺序。 */
  lastStarted: Promise<void> | null;
  /** 在途 flush 数：忙碌时下一批可与上一批执行重叠（由各端 handler 串行化）。 */
  inFlight: number;
}

export class InboundMergeWindow<E> {
  private readonly states = new Map<string, KeyState<E>>();

  constructor(private readonly options: InboundMergeWindowOptions<E>) {}

  /** 提交一条入站消息。
   *  豁免/禁用路径（windowMs<=0 或 canJoin=false）的 onFlush 异常向上抛给调用方——与加窗前的
   *  process() 契约一致（monitor 的 catch 负责记日志）；定时器驱动的 flush 无调用方，异常由组件记日志。 */
  async submit(entry: E): Promise<void> {
    const key = this.options.keyOf(entry);
    const joinable = this.options.windowMs > 0 && this.options.canJoin(entry);
    if (!joinable) {
      // 先冲刷同键在途批次（只等启动），再单独触发本条，保证豁免消息不抢在批次之前。
      await this.flushKey(key);
      await this.options.onFlush([entry]);
      return;
    }
    const state = this.ensureState(key);
    const dedupeKey = this.options.dedupeKeyOf(entry);
    if (dedupeKey != null && state.entries.some((e) => this.options.dedupeKeyOf(e) === dedupeKey)) return;
    state.entries.push(entry);
    // 在途 flush 不阻塞新批次的窗口：忙碌时合并批作为一条队列行/一次取代，见各端适配。
    if (state.timer == null) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.flushKey(key);
      }, this.options.windowMs);
      state.timer.unref?.();
    }
  }

  /** 关机时 best-effort 冲刷全部在途批次：只保证 flush 启动，不等待执行完成（执行由停机收尾等待）。 */
  async flushAll(): Promise<void> {
    const keys = [...this.states.keys()];
    await Promise.all(keys.map((key) => this.flushKey(key)));
  }

  /**
   * 冲刷指定键的在途批次。返回的 Promise 在 onFlush 被调用（同步段执行完）后 resolve，
   * 不等执行完成；空缓冲时若有刚启动的 flush 则等它启动，否则立即resolve。
   */
  private flushKey(key: string): Promise<void> {
    const state = this.states.get(key);
    if (state == null) return Promise.resolve();
    if (state.timer != null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.entries.length === 0) {
      return state.lastStarted ?? Promise.resolve();
    }
    const batch = this.takeBatch(state);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    state.lastStarted = started;
    state.inFlight += 1;
    const done = (async () => {
      try {
        await this.options.onFlush(batch);
      } catch (error) {
        // 单批失败只记日志：claim 收尾由适配层在自身 finally 完成，键状态下方照常复位。
        console.error(`入站合并窗口 flush 失败, key=${key}, size=${batch.length}`, error);
      }
    })();
    // 异步 IIFE 已同步执行到 onFlush 的第一个 await：onFlush 确已调用，放行等待方。
    resolveStarted();
    void done.then(() => {
      state.inFlight -= 1;
      this.maybeCleanup(key, state);
    });
    return started;
  }

  private takeBatch(state: KeyState<E>): E[] {
    const batch = state.entries.slice();
    state.entries.length = 0;
    if (this.options.seqOf != null) {
      batch.sort((a, b) => this.options.seqOf!(a) - this.options.seqOf!(b));
    }
    return batch;
  }

  private ensureState(key: string): KeyState<E> {
    let state = this.states.get(key);
    if (state == null) {
      state = { entries: [], timer: null, lastStarted: null, inFlight: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private maybeCleanup(key: string, state: KeyState<E>): void {
    if (state.entries.length === 0 && state.timer == null && state.inFlight === 0
      && this.states.get(key) === state) {
      this.states.delete(key);
    }
  }
}
