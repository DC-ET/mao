/**
 * 按绝对路径串行化文件读-改-写，避免并行工具调用对同一文件
 * 各自 readFileSync 旧内容后先后 writeFileSync 互相覆盖。
 */
const pathLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = filePath;
  const prev = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => current, () => current);
  pathLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === chained) {
      pathLocks.delete(key);
    }
  }
}
