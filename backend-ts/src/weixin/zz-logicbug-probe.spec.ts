import { describe, expect, it, vi } from 'vitest';
import { WeixinInboundMessageRepository } from './inbound-message.repository.js';
import type { Db } from '../db/db.js';

/**
 * 回归（BUG-3）：`shouldSkipDuplicate` / `findLatestInboundAt` 曾把 DB 返回的
 * DATETIME 字符串按 UTC 解析（`replace(' ', 'T') + 'Z'`），而 db.ts 的 pool 固定
 * `timezone: '+08:00'` 且 `dateStrings: true`——字符串本身就是上海本地墙钟，
 * 强加 'Z' 后整体前移 8 小时：30h 前的 DONE 行被算成 22h（用户合法重发被误判为
 * 服务端重投而跳过），20h 前的入站被算成 12h（24h 主动发送窗口误判为仍打开）。
 *
 * 修复改用与 schedule / auth 同口径的 parseShanghaiDateTime（+08:00）。
 */

/** 返回给定行的假 Db，按 sql 片段路由到 queryOne。 */
function dbReturning(rows: Record<string, unknown>): Db {
  return {
    queryOne: vi.fn(async () => rows),
    query: vi.fn(async () => []),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    transaction: vi.fn(),
  } as unknown as Db;
}

/** 上海墙钟「N 小时前」，与 MySQL DATE_SUB(CURRENT_TIMESTAMP, INTERVAL N HOUR) 同口径。 */
function shanghaiHoursAgoSql(hours: number): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const utc = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - hours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`;
}

/** 由上海墙钟字符串还原真实经过时长（毫秒），用于断言「解析口径没有偏移」。 */
function ageOfShanghaiString(sql: string): number {
  const [date, time] = sql.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return Date.now() - Date.UTC(y, m - 1, d, hh - 8, mm, ss);
}

describe('BUG-3 回归：weixin DB 时间串必须按 +08:00 解析', () => {
  it('E1 30 小时前的 DONE 行：超过 24h 去重窗口，用户合法重发放行', async () => {
    const updatedAt = shanghaiHoursAgoSql(30);
    const repo = new WeixinInboundMessageRepository(dbReturning({ status: 'DONE', updatedAt }));
    const skip = await repo.shouldSkipDuplicate('acc', 'key');
    console.log('E1 updatedAt =', updatedAt, '；真实年龄 =', (ageOfShanghaiString(updatedAt) / 3600000).toFixed(2), '小时；shouldSkipDuplicate =', skip, '（应为 false）');
    expect(skip).toBe(false);
  });

  it('E2 26 小时前的入站：超过 24h 主动发送窗口已关闭', async () => {
    const createdAt = shanghaiHoursAgoSql(26);
    const repo = new WeixinInboundMessageRepository(dbReturning({ createdAt }));
    const latest = await repo.findLatestInboundAt('acc');
    const ageMs = Date.now() - latest!.getTime();
    const open = ageMs < 24 * 60 * 60 * 1000;
    console.log('E2 createdAt =', createdAt, '；解析后年龄 =', (ageMs / 3600000).toFixed(2), '小时；窗口打开 =', open, '（应为 false）');
    expect(open).toBe(false);
  });

  it('E2b 22 小时前的入站：仍在 24h 主动发送窗口内', async () => {
    const createdAt = shanghaiHoursAgoSql(22);
    const repo = new WeixinInboundMessageRepository(dbReturning({ createdAt }));
    const latest = await repo.findLatestInboundAt('acc');
    const ageMs = Date.now() - latest!.getTime();
    const open = ageMs < 24 * 60 * 60 * 1000;
    console.log('E2b createdAt =', createdAt, '；解析后年龄 =', (ageMs / 3600000).toFixed(2), '小时；窗口打开 =', open, '（应为 true）');
    expect(open).toBe(true);
  });

  it('E3 对照组：2 小时前的行两种口径都判为窗口内/重投内', async () => {
    const updatedAt = shanghaiHoursAgoSql(2);
    const done = new WeixinInboundMessageRepository(dbReturning({ status: 'DONE', updatedAt }));
    expect(await done.shouldSkipDuplicate('acc', 'key')).toBe(true);

    const createdAt = shanghaiHoursAgoSql(2);
    const latest = await new WeixinInboundMessageRepository(dbReturning({ createdAt })).findLatestInboundAt('acc');
    expect(Date.now() - latest!.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('E4 解析口径无偏移：findLatestInboundAt 还原的时间与真实墙钟一致', async () => {
    const createdAt = shanghaiHoursAgoSql(6);
    const latest = await new WeixinInboundMessageRepository(dbReturning({ createdAt })).findLatestInboundAt('acc');
    const expected = ageOfShanghaiString(createdAt);
    // 容许本次调用与构造字符串之间的秒级抖动
    expect(Math.abs(Date.now() - latest!.getTime() - expected)).toBeLessThan(2000);
  });

  it('E5 非 DONE 行仍视为重投跳过（不受解析口径影响）', async () => {
    const repo = new WeixinInboundMessageRepository(dbReturning({ status: 'CLAIMED', updatedAt: shanghaiHoursAgoSql(100) }));
    expect(await repo.shouldSkipDuplicate('acc', 'key')).toBe(true);
  });

  it('E6 查无记录时返回 null', async () => {
    const repo = new WeixinInboundMessageRepository(dbReturning({}));
    expect(await repo.findLatestInboundAt('acc')).toBeNull();
  });

  it('E7 已是 Date 对象时原样使用（不走字符串解析）', async () => {
    const asDate = new Date(Date.now() - 30 * 3600_000);
    const repo = new WeixinInboundMessageRepository(dbReturning({ status: 'DONE', updatedAt: asDate }));
    expect(await repo.shouldSkipDuplicate('acc', 'key')).toBe(false);
  });
});
