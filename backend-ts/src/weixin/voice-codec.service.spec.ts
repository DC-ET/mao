import { describe, expect, it } from 'vitest';
import { estimateWavDurationMs } from './voice-codec.service.js';

function wavHeader(dataSize: number, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('WeixinVoiceCodecService', () => {
  it('estimateWavDurationMsFromHeader', () => {
    const wav = wavHeader(48000);
    expect(estimateWavDurationMs(wav)).toBe(1000);
  });

  it('estimateWavDurationMsFallback', () => {
    const bytes = Buffer.from('not-a-wav');
    expect(estimateWavDurationMs(bytes)).toBe(Math.floor((bytes.length * 1000) / (24000 * 2)));
  });
});
