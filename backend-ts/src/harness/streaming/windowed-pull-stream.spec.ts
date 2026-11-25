import { describe, expect, it, vi } from 'vitest';
import { createWindowedReadStream } from './windowed-pull-stream.js';

const CHUNK = 4;

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('createWindowedReadStream（2026-11-25 R2）', () => {
  it('按窗口预取、顺序产出全部字节', async () => {
    const source = Buffer.from('0123456789abcdef');
    const calls: Array<{ offset: number; length: number }> = [];
    const stream = createWindowedReadStream({
      size: source.length,
      chunkBytes: CHUNK,
      windowSize: 3,
      read: async (offset, length) => {
        calls.push({ offset, length });
        await new Promise((r) => setTimeout(r, 1));
        return source.subarray(offset, offset + length);
      },
    });
    const out = await collect(stream);
    expect(out.equals(source)).toBe(true);
    expect(calls.every((c) => c.length <= CHUNK)).toBe(true);
    // 窗口：前 3 片在首次消费前已发出
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('短读（远端提前 EOF）按完整性失败，不静默产出错位字节', async () => {
    const stream = createWindowedReadStream({
      size: 8,
      chunkBytes: 4,
      windowSize: 2,
      read: async (offset, length) => Buffer.alloc(Math.max(0, length - 1)),
    });
    await expect(collect(stream)).rejects.toThrow('读取中断');
  });

  it('销毁时调用 onClose（释放执行端句柄），且只调一次', async () => {
    const onClose = vi.fn();
    const stream = createWindowedReadStream({
      size: 1024 * 1024,
      chunkBytes: CHUNK,
      windowSize: 2,
      read: async (_offset, length) => new Promise<Buffer>((resolve) => {
        setTimeout(() => resolve(Buffer.alloc(length)), 50);
      }),
      onClose,
    });
    stream.destroy();
    await new Promise((r) => setTimeout(r, 120));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('size=0：不发起任何读取，流正常结束', async () => {
    const read = vi.fn();
    const stream = createWindowedReadStream({ size: 0, read });
    await expect(collect(stream)).resolves.toEqual(Buffer.alloc(0));
    expect(read).not.toHaveBeenCalled();
  });
});
