/**
 * round2 复现/回归用例（问题 3 修复后）：
 *  1) 落盘失败时同一路径在同一进程内稳定（修复目标）；
 *  2) 不同路径互不影响（缓存按路径隔离，避免测试/多 HOME 串味）；
 *  3) 缓存命中后即使文件被删除，本进程内仍复用同一 id（重连不再变成新设备）；
 *  4) 观察项：首次写盘失败后，即使稍后路径变为可写，也不会补写（id 无法跨进程延续）。
 *
 * 运行：cp docs/code-review/repro/cli-device-identity-stability.probe.spec.ts agent-cli/test/
 *       cd agent-cli && npx vitest run test/cli-device-identity-stability.probe.spec.ts
 */
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

describe('probe(round2): 设备身份稳定性与缓存隔离', () => {
  it('可写路径：多次解析得到同一 deviceId 且已落盘', () => {
    const file = path.join(ws, 'device.json');
    const first = resolveDeviceIdentity(file);
    expect(resolveDeviceIdentity(file).id).toBe(first.id);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string }).id).toBe(first.id);
  });

  it('不可写路径：同一进程内多次解析保持同一 deviceId（round1 缺陷已修）', () => {
    const blocker = path.join(ws, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'device.json');
    const first = resolveDeviceIdentity(file);
    const second = resolveDeviceIdentity(file);
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('不同路径互不影响（缓存按路径隔离）', () => {
    const a = path.join(ws, 'a', 'device.json');
    const b = path.join(ws, 'b', 'device.json');
    const idA = resolveDeviceIdentity(a).id;
    const idB = resolveDeviceIdentity(b).id;
    expect(idA).not.toBe(idB);
    expect(resolveDeviceIdentity(a).id).toBe(idA);
    expect(resolveDeviceIdentity(b).id).toBe(idB);
    // 两个文件各自落盘了自己的 id
    expect((JSON.parse(fs.readFileSync(a, 'utf8')) as { id: string }).id).toBe(idA);
    expect((JSON.parse(fs.readFileSync(b, 'utf8')) as { id: string }).id).toBe(idB);
  });

  it('缓存命中后文件被删除：本进程内仍复用同一 id', () => {
    const file = path.join(ws, 'device.json');
    const first = resolveDeviceIdentity(file);
    fs.rmSync(file);
    expect(resolveDeviceIdentity(file).id).toBe(first.id);
  });

  it('观察项：首次写盘失败后路径变可写，也不会补写（id 无法跨进程延续）', () => {
    const blocker = path.join(ws, 'blocker2');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'device.json');
    const id = resolveDeviceIdentity(file).id;
    // 让路径变为可写（用目录替换该文件）
    fs.rmSync(blocker);
    fs.mkdirSync(blocker);
    expect(resolveDeviceIdentity(file).id).toBe(id);
    // 文件仍然没有被补写：下次进程启动会生成新 id
    expect(fs.existsSync(file)).toBe(false);
  });
});
