import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, PendingRegistry, MAX_FRAME_BYTES } from './runtime-channel-protocol.js';

describe('runtime channel protocol', () => {
  it('encodesAndDecodesFramesAcrossChunkBoundaries', () => {
    const frames = [
      { v: 1, type: 'ping', id: 'a' },
      { v: 1, type: 'tool_result', id: 'b', ok: true, result: '{"x":1}', durationMs: 5 },
      { v: 1, type: 'pong', id: 'c' },
    ];
    const wire = Buffer.concat(frames.map(encodeFrame));
    const decoder = new FrameDecoder();
    // 逐字节喂入：分帧必须正确处理任意切分
    const out = [];
    for (const byte of wire) {
      out.push(...decoder.push(Buffer.from([byte])));
    }
    expect(out.map((f) => f.type)).toEqual(['ping', 'tool_result', 'pong']);
    expect((out[1] as { result: string }).result).toBe('{"x":1}');
  });

  it('rejectsOversizedFrames', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(/exceeds limit/);
  });

  it('rejectsInvalidJsonAndBadVersion', () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from('not-json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    expect(() => decoder.push(Buffer.concat([header, body]))).toThrow(/JSON/);

    const badVersion = Buffer.from(JSON.stringify({ v: 999, type: 'ping', id: 'x' }), 'utf8');
    header.writeUInt32BE(badVersion.length, 0);
    expect(() => decoder.push(Buffer.concat([header, badVersion]))).toThrow(/version/);
  });

  it('acceptsHelloWithOptionalBuildField', () => {
    // V178 回归：hello 帧新增可选 build 字段（容器内代码版本）——旧宿主松校验，
    // 缺字段的旧 agent 也必须能通过（双向兼容）
    const decoder = new FrameDecoder();
    const wire = Buffer.concat([
      encodeFrame({ v: 1, type: 'hello', userId: 7, token: 't', build: 'build-abc' }),
      encodeFrame({ v: 1, type: 'hello', userId: 7, token: 't' }),
    ]);
    const out = decoder.push(wire);
    expect(out[0].type).toBe('hello');
    expect((out[0] as { build?: string }).build).toBe('build-abc');
    expect((out[1] as { build?: string }).build).toBeUndefined();
  });

  it('pendingRegistryResolvesAndTimesOut', async () => {
    const registry = new PendingRegistry<string>();
    const wait = registry.register('r1', 50, 'timeout test');
    expect(registry.resolve('r1', 'done')).toBe(true);
    await expect(wait).resolves.toBe('done');

    const failing = registry.register('r2', 20, 'timeout test');
    await expect(failing).rejects.toThrow(/timeout/);
  });

  it('pendingRegistryFailsAllOnClose', async () => {
    const registry = new PendingRegistry<string>();
    const wait = registry.register('x', 5000, 'close test');
    registry.failAll(new Error('closed'));
    await expect(wait).rejects.toThrow('closed');
    expect(registry.size).toBe(0);
  });
});
