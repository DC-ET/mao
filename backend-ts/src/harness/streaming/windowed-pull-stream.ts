import { Readable } from 'node:stream';

/**
 * 服务端窗口拉取的通用流（技术方案 2026-11-25-send-file-1gb R2）。
 *
 * Docker 运行时通道与 LOCAL 执行端 WS 都没有反压：执行端一口气推 2048 片时，
 * 落盘 / 上云一慢，片就堆在服务端内存或 `FrameDecoder.buffer` 里；暂停 socket 又会把
 * 同通道的 pty / `tool_result` 一起卡住。改为服务端按区间拉取：
 *
 * - 最多保持 `windowSize` 片在途（默认 8 × 512KB = 4MB）；
 * - 按 offset 顺序 yield，天然有序，不需要乱序重排；
 * - 下游 pipe 的背压经 `Readable.from` 传回生成器，慢消费时不再继续发起读取；
 * - 流被销毁（含取消 / 写入失败）时调用 `onClose` 关闭远端句柄；
 * - **正常读完不主动关闭**：调用方可先向执行端要整份 sha256（R8）再显式 close，
 *   否则 1GB 读完立刻关句柄会让摘要校验无从比对。
 */
export interface WindowedReadOptions {
  /** 源端总字节数（open 阶段已 stat）。 */
  size: number;
  /** 单片字节上限，默认 512KB（base64 后 ≈683KB，卡在 WS 1MB maxPayload 内）。 */
  chunkBytes?: number;
  /** 在途片数窗口，默认 8。 */
  windowSize?: number;
  /** 读取 [offset, offset+length)；长度可能小于 chunkBytes（末片）。 */
  read: (offset: number, length: number) => Promise<Buffer>;
  /** 中途失败 / 被销毁时调用（关闭远端句柄）；正常读完由调用方显式 close。 */
  onClose?: () => void | Promise<void>;
}

export const WINDOWED_READ_CHUNK_BYTES = 512 * 1024;
export const WINDOWED_READ_WINDOW_SIZE = 8;

export function createWindowedReadStream(options: WindowedReadOptions): Readable {
  const size = options.size;
  const chunkBytes = options.chunkBytes ?? WINDOWED_READ_CHUNK_BYTES;
  const windowSize = Math.max(1, options.windowSize ?? WINDOWED_READ_WINDOW_SIZE);
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await options.onClose?.();
  };
  let completed = false;
  const generator = async function* (): AsyncGenerator<Buffer> {
    const pending: Array<Promise<Buffer>> = [];
    const pendingLengths: number[] = [];
    let next = 0;
    try {
      while (next < size || pending.length > 0) {
        while (pending.length < windowSize && next < size) {
          const offset = next;
          const length = Math.min(chunkBytes, size - offset);
          next += length;
          const read = options.read(offset, length);
          // 提前销毁时在途读取仍可能 reject：挂一个空捕获，避免 unhandledRejection；
          // 正常路径仍从这个 promise 取值并按原错误抛出。
          void read.catch(() => {});
          pending.push(read);
          pendingLengths.push(length);
        }
        if (pending.length === 0) break;
        const expected = pendingLengths.shift()!;
        const chunk = await pending.shift()!;
        // 短读会让后续 offset 与真实字节错位（截断 / 远端提前 EOF），按完整性失败处理（R8）
        if (chunk.length !== expected) {
          throw new Error(`读取中断（期望 ${expected} 字节，实际 ${chunk.length}），请重试`);
        }
        yield chunk;
      }
      completed = true;
    } finally {
      if (!completed) await closeOnce();
    }
  };
  const stream = Readable.from(generator(), { highWaterMark: chunkBytes });
  let ended = false;
  stream.once('end', () => { ended = true; });
  // 未开始消费 / 中途销毁时生成器的 finally 不一定跑：close 事件兜底释放远端句柄
  stream.once('close', () => { if (!ended) void closeOnce(); });
  return stream;
}
