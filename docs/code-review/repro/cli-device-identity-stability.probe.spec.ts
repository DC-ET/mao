import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDeviceIdentity } from '../src/local/device-identity';

let ws: string;

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-device-probe-')));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('probe: 设备身份在落盘失败时的稳定性', () => {
  it('可写路径：多次解析得到同一 deviceId', () => {
    const file = path.join(ws, 'device.json');
    expect(resolveDeviceIdentity(file).id).toBe(resolveDeviceIdentity(file).id);
  });

  it('不可写路径：同一进程内多次解析应保持同一 deviceId（当前实现每次生成新值）', () => {
    // 父路径是文件 → mkdir/rename 必然失败，模拟 HOME 只读 / 磁盘满 / 权限不足
    const blocker = path.join(ws, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'device.json');
    const first = resolveDeviceIdentity(file);
    const second = resolveDeviceIdentity(file);
    // 期望：落盘失败时本进程内仍复用同一个 id（否则每次 WS 重连都会变成"新设备"）
    expect(second.id).toBe(first.id);
  });
});
