import { describe, expect, it } from 'vitest';
import { parseWavInfo } from './model.service.js';

/**
 * 回归用例：WAV 的 data chunk 声明长度未与实际字节数取小，时长被放大成天文数字。
 *
 * 位置：backend-ts/src/model/model.service.ts:431-476 —— 解析 chunk 时
 * `dataSize = chunkSize`（:462-464）直接采用头部声明的 32 位长度，既不校验是否超过
 * `bytes.length - bodyStart`，也不与 RIFF 容器长度取小；时长按声明值换算（:473-474）。
 *
 * 触发输入完全合法：流式/不可回填长度的编码器把 data 长度写成占位值（0x7FFFFFFF 是
 * 最常见的「未知长度」写法），或文件在传输中被截断。24kHz / 单声道 / 16bit 下，
 * 4 个真实字节会被换算成约 12.4 小时。
 *
 * 期望：时长必须落在「文件实际存在的字节」范围内——要么按实际剩余字节钳制
 * （4 字节 → 0ms），要么判定不可用返回 null；绝不能凭空造出声明值对应的时长。
 */
function wavWithDataChunk(declaredSize: number, actualDataBytes: number): Buffer {
  const data = Buffer.alloc(actualDataBytes, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + actualDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24); // 24kHz
  header.writeUInt32LE(48000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // 16bit
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(declaredSize >>> 0, 40);
  return Buffer.concat([header, data]);
}

describe('parseWavInfo bounds the duration by actual bytes', () => {
  it('does not report ~12.4h for a 4-byte data chunk declaring 0x7FFFFFFF', () => {
    const info = parseWavInfo(wavWithDataChunk(0x7fffffff, 4));
    // 实际 4 字节 @ 48000 B/s ≈ 0ms；返回 null 也算合理收口
    expect(info?.durationMs ?? 0).toBeLessThanOrEqual(1);
  });

  it('does not report a phantom duration for a truncated 1000-byte declaration', () => {
    const info = parseWavInfo(wavWithDataChunk(1000, 4));
    expect(info?.durationMs ?? 0).toBeLessThanOrEqual(1);
  });

  it('still reports the exact duration for a well-formed file (control group)', () => {
    const info = parseWavInfo(wavWithDataChunk(4800, 4800));
    expect(info).toEqual({ sampleRate: 24000, durationMs: 100 });
  });
});
