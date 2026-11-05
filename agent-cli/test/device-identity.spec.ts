import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDeviceIdentity } from '../src/local/device-identity';

let ws: string;

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-device-')));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('device identity', () => {
  it('generates a stable id on first read and persists it', () => {
    const file = path.join(ws, 'device.json');
    const first = resolveDeviceIdentity(file);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.platform).toBe(process.platform);

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: string };
    expect(persisted.id).toBe(first.id);

    const second = resolveDeviceIdentity(file);
    expect(second.id).toBe(first.id);
  });

  it('regenerates when the persisted id is dirty or missing', () => {
    const file = path.join(ws, 'device.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'bad id!' }));
    const device = resolveDeviceIdentity(file);
    expect(device.id).not.toBe('bad id!');
    expect(device.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: string }).id).toBe(device.id);

    fs.writeFileSync(file, '{not json');
    const again = resolveDeviceIdentity(file);
    expect(again.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('keeps returning a usable id even when the file cannot be written', () => {
    // 目录不存在且父路径是文件：写盘必然失败，内存值仍可用且进程内稳定
    const blocker = path.join(ws, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'device.json');
    const device = resolveDeviceIdentity(file);
    expect(device.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(resolveDeviceIdentity(file).id).toBe(device.id);
  });
});
