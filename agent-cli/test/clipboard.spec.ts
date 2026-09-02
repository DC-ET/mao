import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 记录每次 spawn 的调用，并按脚本给出成功/失败。 */
interface Call {
  command: string;
  args: string[];
  written: string;
}

const calls: Call[] = [];
let plan: Record<string, 'ok' | 'fail' | 'error'> = {};

class FakeChild extends EventEmitter {
  readonly stdin = new (class extends EventEmitter {
    text = '';
    end(chunk?: string): void {
      if (chunk !== undefined) this.text += chunk;
    }
  })();
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = new FakeChild();
    const call: Call = { command, args, written: '' };
    calls.push(call);
    const outcome = plan[command] ?? 'error';
    setTimeout(() => {
      call.written = child.stdin.text;
      if (outcome === 'error') child.emit('error', new Error('ENOENT'));
      else child.emit('close', outcome === 'ok' ? 0 : 1);
    }, 0);
    return child;
  },
}));

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  calls.length = 0;
  plan = {};
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.resetModules();
});

async function clipboard() {
  return import('../src/ui/clipboard');
}

describe('copyToClipboard', () => {
  it('refuses empty text without spawning anything', async () => {
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uses pbcopy on macOS', async () => {
    setPlatform('darwin');
    plan = { pbcopy: 'ok' };
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['pbcopy']);
    expect(calls[0].written).toBe('hello');
  });

  it('uses clip on Windows', async () => {
    setPlatform('win32');
    plan = { clip: 'ok' };
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['clip']);
  });

  it('prefers wl-copy on Linux', async () => {
    setPlatform('linux');
    plan = { 'wl-copy': 'ok', xclip: 'ok' };
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['wl-copy']);
  });

  it('falls back through xclip to xsel', async () => {
    setPlatform('linux');
    plan = { xsel: 'ok' };
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['wl-copy', 'xclip', 'xsel']);
    expect(calls[2].args).toEqual(['--clipboard', '--input']);
  });

  it('treats a non-zero exit as failure and keeps trying', async () => {
    setPlatform('linux');
    plan = { 'wl-copy': 'fail', xclip: 'ok' };
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['wl-copy', 'xclip']);
    expect(calls[1].args).toEqual(['-selection', 'clipboard']);
  });

  it('returns false when no clipboard command works', async () => {
    setPlatform('linux');
    const { copyToClipboard } = await clipboard();
    await expect(copyToClipboard('hello')).resolves.toBe(false);
    expect(calls.map((c) => c.command)).toEqual(['wl-copy', 'xclip', 'xsel']);
  });
});
