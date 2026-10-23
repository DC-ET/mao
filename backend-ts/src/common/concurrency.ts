/**
 * 有界并发执行：用于 CPU/内存敏感的任务（图片解码、sharp 编码等）。
 *
 * 为什么不用 `Promise.all`：并发数不受控时，N 张大图同时解码会把单进程 RSS 顶到 GB 级
 * （8000×6000 JPEG ≈ 144MB 原始像素/张），影响同进程的其他会话。
 * 结果顺序与输入一致；首个错误立即抛出，其余 worker 不再领取新任务（已在跑的会自然结束）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = items.length;
  const results = new Array<R>(size);
  if (size === 0) return results;
  const width = Math.max(1, Math.min(Math.floor(limit), size));
  let next = 0;
  let aborted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      const index = next++;
      if (index >= size) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (e) {
        aborted = true; // 首个错误后不再派发新任务；已在跑的会自然结束
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
