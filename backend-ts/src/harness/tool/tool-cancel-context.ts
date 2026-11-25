import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 工具执行期间的本轮取消信号（技术方案 2026-11-25-send-file-1gb R4）。
 *
 * 工具执行链路今天不接收 AbortSignal：30MB 时无所谓，1GB 的发送会持续数分钟，
 * 用户点停止后传输仍在后台跑完，并插一行没有消息引用的 `send_file`（快照无 GC，
 * 变成永久孤儿）。AgentLoop 在每次工具调用前把本轮的 cancelFlag 放进这里，
 * `send_file` / `send_image` 逐块检查；置位时中断来源、删除临时文件、不插表。
 *
 * 其它装配（子代理恢复、测试直调）没有这一层时取到 null，行为与改造前一致。
 */
export interface ToolCancelSignal {
  get(): boolean;
}

const storage = new AsyncLocalStorage<ToolCancelSignal | null>();

export const ToolCancelContext = {
  current(): ToolCancelSignal | null {
    return storage.getStore() ?? null;
  },

  run<T>(signal: ToolCancelSignal | null | undefined, fn: () => T): T {
    return storage.run(signal ?? null, fn);
  },
};
