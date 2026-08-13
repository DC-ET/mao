import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WeixinBotConfig } from './types.js';

const SAMPLE_RATE = 24000;

export interface SilkVoice {
  silkBytes: Buffer;
  playtimeMs: number;
}

export class WeixinVoiceCodecService {
  constructor(private readonly weixinBotConfig: WeixinBotConfig) {}

  async wavToMp3(wavBytes: Buffer): Promise<Buffer | null> {
    let workDir: string | null = null;
    try {
      workDir = mkdtempSync(join(tmpdir(), 'mao-weixin-voice-'));
      const wavPath = join(workDir, 'in.wav');
      const mp3Path = join(workDir, 'out.mp3');
      writeFileSync(wavPath, wavBytes);
      const ok = await this.runProcess(this.weixinBotConfig.ffmpegPath, [
        '-y', '-i', wavPath,
        '-vn', '-c:a', 'libmp3lame', '-b:a', '32k',
        '-ar', String(SAMPLE_RATE), '-ac', '1',
        mp3Path,
      ]);
      if (!ok) {
        console.warn('微信语音转码：ffmpeg 转 MP3 失败');
        return null;
      }
      const mp3Bytes = readFileSync(mp3Path);
      if (mp3Bytes.length === 0) return null;
      console.info(`微信语音转码：WAV ${wavBytes.length} bytes → MP3 ${mp3Bytes.length} bytes`);
      return mp3Bytes;
    } catch (e) {
      console.warn(`微信语音转码（MP3）异常: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      if (workDir) {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  async wavToSilk(wavBytes: Buffer): Promise<SilkVoice | null> {
    let workDir: string | null = null;
    try {
      workDir = mkdtempSync(join(tmpdir(), 'mao-weixin-voice-'));
      const wavPath = join(workDir, 'in.wav');
      const pcmPath = join(workDir, 'in.pcm');
      const silkPath = join(workDir, 'out.silk');
      writeFileSync(wavPath, wavBytes);
      if (!(await this.runProcess(this.weixinBotConfig.ffmpegPath, [
        '-y', '-i', wavPath,
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
        pcmPath,
      ]))) {
        console.warn('微信语音转码：ffmpeg 转 PCM 失败');
        return null;
      }
      if (!(await this.runProcess(this.weixinBotConfig.silkEncoderPath, [
        pcmPath, silkPath, '-Fs_API', String(SAMPLE_RATE), '-tencent',
      ]))) {
        console.warn('微信语音转码：SILK 编码失败');
        return null;
      }
      const silkBytes = readFileSync(silkPath);
      if (silkBytes.length === 0) return null;
      const playtimeMs = estimateWavDurationMs(wavBytes);
      console.info(`微信语音转码：WAV ${wavBytes.length} bytes → SILK ${silkBytes.length} bytes, playtime=${playtimeMs}ms`);
      return { silkBytes, playtimeMs };
    } catch (e) {
      console.warn(`微信语音转码异常: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      if (workDir) {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  private runProcess(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => chunks.push(c));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        console.warn(`微信语音转码：进程超时, cmd=${cmd} ${args.join(' ')}`);
        resolve(false);
      }, 60_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        console.warn(`微信语音转码：执行失败, cmd=${cmd} ${args.join(' ')}: ${e.message}`);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const output = Buffer.concat(chunks).toString('utf8');
          console.warn(`微信语音转码：进程退出码 ${code}, cmd=${cmd} ${args.join(' ')}, output=${output.slice(0, 500)}`);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
}

export function estimateWavDurationMs(wav: Buffer): number {
  try {
    if (wav.length >= 44
      && wav[0] === 0x52 && wav[1] === 0x49 && wav[2] === 0x46 && wav[3] === 0x46
      && wav[8] === 0x57 && wav[9] === 0x41 && wav[10] === 0x56 && wav[11] === 0x45) {
      let offset = 12;
      let sampleRate = 0;
      let channels = 1;
      let bits = 16;
      let dataSize = 0;
      while (offset + 8 <= wav.length) {
        const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
        const chunkSize = wav[offset + 4]! | (wav[offset + 5]! << 8) | (wav[offset + 6]! << 16) | (wav[offset + 7]! << 24);
        const body = offset + 8;
        if (chunkId === 'fmt ' && body + 16 <= wav.length) {
          sampleRate = wav[body + 4]! | (wav[body + 5]! << 8) | (wav[body + 6]! << 16) | (wav[body + 7]! << 24);
          channels = wav[body + 2]! | (wav[body + 3]! << 8);
          bits = wav[body + 14]! | (wav[body + 15]! << 8);
        } else if (chunkId === 'data') {
          dataSize = chunkSize >>> 0;
        }
        offset = body + Math.min(chunkSize >>> 0, 0x7fffffff);
        if ((chunkSize & 1) === 1) offset += 1;
      }
      const bytesPerSec = sampleRate > 0 ? sampleRate * Math.max(channels, 1) * (bits / 8) : 0;
      if (bytesPerSec > 0 && dataSize > 0) {
        return Math.floor((dataSize * 1000) / bytesPerSec);
      }
    }
  } catch { /* ignore */ }
  return Math.floor((wav.length * 1000) / (SAMPLE_RATE * 2));
}
