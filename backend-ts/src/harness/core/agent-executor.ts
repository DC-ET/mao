export class AgentExecutorRejectedError extends Error {
  constructor(active: number, queued: number, maxPoolSize: number, queueCapacity: number) {
    super(
      `Agent executor rejected: active=${active} queued=${queued} max=${maxPoolSize} queueCapacity=${queueCapacity}`,
    );
    this.name = 'AgentExecutorRejectedError';
  }
}

/**
 * Mirrors Java ThreadPoolTaskExecutor: core / max / bounded queue, then reject.
 * After core workers are busy, tasks queue; extra workers up to max are created only when the queue is full.
 */
export function createAgentExecutor(
  corePoolSize: number,
  maxPoolSize = corePoolSize,
  queueCapacity = Number.POSITIVE_INFINITY,
): {
  submit(fn: () => void | Promise<void>): void;
} {
  const core = Math.max(1, corePoolSize);
  const max = Math.max(core, maxPoolSize);
  const capacity = Math.max(0, queueCapacity);
  let active = 0;
  const queue: Array<() => Promise<void>> = [];

  const start = (task: () => Promise<void>): void => {
    active += 1;
    void task().finally(() => {
      active -= 1;
      const next = queue.shift();
      if (next) start(next);
    });
  };

  return {
    submit(fn: () => void | Promise<void>): void {
      const task = async () => {
        await fn();
      };
      if (active < core) {
        start(task);
        return;
      }
      if (queue.length < capacity) {
        queue.push(task);
        return;
      }
      if (active < max) {
        start(task);
        return;
      }
      throw new AgentExecutorRejectedError(active, queue.length, max, capacity);
    },
  };
}
