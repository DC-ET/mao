// 投递取数 URL 解析（活引用方案 2026-11-20 §5.2，与 desktop/src/utils/deliveryUrl.ts 同口径）：
// 形态 A（ref）实时拼 workspace-download + token，token 绝不入消息 JSON；形态 B/C 原样返回 url。
// key 用稳定身份，不用含 token 的 resolved URL。
import { describe, expect, it } from 'vitest';
import { deliveryKey, resolveDeliveryUrl } from './deliveryUrl';
import type { SendDelivery } from '../types';

const API_BASE = 'https://mao.example.com/api/v1';

const refDelivery: SendDelivery = {
  kind: 'image',
  ref: { type: 'workspace', sessionId: 42, path: 'reports/图 片.png' },
  mime: 'image/png',
  bytes: 123,
  filename: '图 片.png',
};

const urlDelivery: SendDelivery = {
  kind: 'file',
  url: 'https://mao.example.com/uploads/7/send-abc.pdf',
  mime: 'application/pdf',
  bytes: 9,
  filename: 'a.pdf',
};

describe('resolveDeliveryUrl', () => {
  it('形态 A：拼 workspace-download，token 渲染期追加（空格编码为 %20，与后端严格路径解析同口径）', () => {
    expect(resolveDeliveryUrl(refDelivery, API_BASE, 'jwt-token')).toBe(
      'https://mao.example.com/api/v1/files/workspace-download?sessionId=42&path=reports%2F%E5%9B%BE%20%E7%89%87.png&token=jwt-token',
    );
  });

  it('形态 A：无 token 时不带 token 参数（401 由端点给出，图片走既有占位）', () => {
    const url = resolveDeliveryUrl(refDelivery, API_BASE, null);
    expect(url).toContain('sessionId=42');
    expect(url).toContain('path=reports%2F%E5%9B%BE%20%E7%89%87.png');
    expect(url).not.toContain('token');
  });

  it('形态 B/C：原样返回 url，不追加 token', () => {
    expect(resolveDeliveryUrl(urlDelivery, API_BASE, 'jwt-token')).toBe(urlDelivery.url);
  });
});

describe('deliveryKey', () => {
  it('形态 A 用 ref（sessionId + type + path）做稳定 key，与 token 无关', () => {
    expect(deliveryKey(refDelivery)).toBe('ref:42:workspace:reports/图 片.png');
  });

  it('形态 B/C 用 url 做 key', () => {
    expect(deliveryKey(urlDelivery)).toBe('https://mao.example.com/uploads/7/send-abc.pdf');
  });
});

// 2026-11-24-send-file-snapshot：send-file 快照 ref。消息只带快照 id，取数拼带属主鉴权的
// send-download；key 用快照 id（不分派 type 会得到 ref:undefined:send-file:undefined，同一轮
// 多个快照共用一个 key，图片网格与下载中状态全撞）。
const snapshotDelivery: SendDelivery = {
  kind: 'image',
  ref: { type: 'send-file', id: '2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f' },
  mime: 'image/png',
  bytes: 123,
  filename: 'a.png',
};

describe('resolveDeliveryUrl：send-file 快照', () => {
  it('拼 send-download，只传 id 与 token', () => {
    expect(resolveDeliveryUrl(snapshotDelivery, API_BASE, 'jwt-token')).toBe(
      'https://mao.example.com/api/v1/files/send-download?id=2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f&token=jwt-token',
    );
  });

  it('无 token 时不带 token 参数', () => {
    expect(resolveDeliveryUrl(snapshotDelivery, API_BASE, null)).toBe(
      'https://mao.example.com/api/v1/files/send-download?id=2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f',
    );
  });
});

describe('deliveryKey：send-file 快照', () => {
  it('用快照 id 做 key，同一轮多个快照不撞', () => {
    const a = { ...snapshotDelivery, ref: { type: 'send-file' as const, id: 'id-a' } };
    const b = { ...snapshotDelivery, ref: { type: 'send-file' as const, id: 'id-b' } };
    expect(deliveryKey(a)).toBe('send-file:id-a');
    expect(deliveryKey(b)).toBe('send-file:id-b');
    expect(deliveryKey(a)).not.toBe(deliveryKey(b));
    expect(deliveryKey(a)).not.toContain('undefined');
  });

  it('与 workspace ref / url 三种 key 互不相同', () => {
    expect(deliveryKey(snapshotDelivery)).not.toBe(deliveryKey(refDelivery));
    expect(deliveryKey(snapshotDelivery)).not.toBe(deliveryKey(urlDelivery));
  });
});
