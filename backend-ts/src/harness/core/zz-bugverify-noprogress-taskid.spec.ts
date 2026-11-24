/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-3）：
 * no-progress-notice.ts 的结果归一化曾只对 send_image|send_file 与 shell 做按工具白名单，
 * 其余工具走 VOLATILE_RESULT_KEYS 黑名单（仅 8 个传输/计时字段）。而 create_scheduled_task
 * 返回 task_id（tool/impl/scheduled-task-tools.ts:104）、create_signal_watcher 返回 watcher_id
 * （signal-watcher-tools.ts:187），都是每次调用全新的 id，既不在黑名单也没有按工具分支。
 * → 模型以相同参数重复创建时每轮签名都不同，streak 永远重置为 1，nudge(5/10) 与 abort(15)
 * 永不触发，正是 AGENTS.md「漏补→漏报」明令禁止的形态。已修复：两个工具各加一条
 * 按工具白名单分支（SEMANTIC_KEYS_BY_TOOL），task_id 不进全局黑名单。
 *
 * 本用例断言「正确行为」：仅随机 id 不同的重复调用应判定为无进展，streak 必须累加。
 * 对照组：同文件已归一化的 send_file 对同样输入能累加，证明修复手段与判定口径现成。
 */
import { describe, expect, it } from 'vitest';

import {
  NO_PROGRESS_ABORT_AT,
  resultDigest,
  scanNoProgressNotices,
  type NoProgressCall,
} from './no-progress-notice.js';
import { NoProgressGuard } from './no-progress-guard.js';
import type { ChatMessage } from '../llm/chat-request.js';

const SCHEDULED_ARGS = '{"name":"每日报告","cron_expression":"0 9 * * *","prompt":"生成昨日数据日报"}';

function scheduledTaskResult(id: number): string {
  return JSON.stringify({
    success: true,
    task_id: id,
    name: '每日报告',
    cron_expression: '0 9 * * *',
    next_fire_time: '2026-11-25T09:00:00',
    session_id: 1,
    message: '定时任务 已创建，下次执行时间: 2026-11-25T09:00:00',
  });
}

const WATCHER_ARGS = '{"name":"价格监控","probe_type":"HTTP","target":"https://example.com/price"}';

function signalWatcherResult(id: number): string {
  return JSON.stringify({
    success: true,
    watcher_id: id,
    name: '价格监控',
    probe_type: 'HTTP',
    target: 'https://example.com/price',
    interval_minutes: 30,
    status: 'ACTIVE',
    trigger_mode: 'CURRENT_SESSION',
  });
}

/** 连续 count 轮同一工具的重复调用，每轮 task 结果只换随机 id。 */
function repeatRounds(
  count: number,
  options: { toolName: string; args: string; result: (index: number) => string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let round = 1; round <= count; round++) {
    const id = `tc_${round}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, type: 'function', function: { name: options.toolName, arguments: options.args } }],
    });
    messages.push({ role: 'tool', toolCallId: id, content: options.result(round) });
  }
  return messages;
}

describe('无进展守护对「每次返回新 id」工具的归一化（回归）', () => {
  it('create_scheduled_task 仅 task_id 不同的重复调用必须累加 streak', () => {
    const rounds = repeatRounds(NO_PROGRESS_ABORT_AT, {
      toolName: 'create_scheduled_task',
      args: SCHEDULED_ARGS,
      result: (index) => scheduledTaskResult(1000 + index),
    });
    const { tail, notices } = scanNoProgressNotices(rounds);
    // 正确行为：同参数重复创建只换了随机 id，属无进展，streak 应一路累加到中止阈值
    expect(tail?.streak).toBe(NO_PROGRESS_ABORT_AT);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('create_signal_watcher 仅 watcher_id 不同的重复调用必须累加 streak', () => {
    const rounds = repeatRounds(NO_PROGRESS_ABORT_AT, {
      toolName: 'create_signal_watcher',
      args: WATCHER_ARGS,
      result: (index) => signalWatcherResult(2000 + index),
    });
    const { tail } = scanNoProgressNotices(rounds);
    expect(tail?.streak).toBe(NO_PROGRESS_ABORT_AT);
  });

  it('运行时 guard 同参数重复创建必须在第 15 轮 abort', () => {
    const guard = new NoProgressGuard();
    let aborted = false;
    for (let round = 1; round <= NO_PROGRESS_ABORT_AT; round++) {
      guard.observeCall({
        toolName: 'create_scheduled_task',
        argumentsJson: SCHEDULED_ARGS,
        resultContent: scheduledTaskResult(3000 + round),
      } satisfies NoProgressCall);
      guard.endRound(`tc_${round}`);
      if (guard.takeAction()?.kind === 'abort') aborted = true;
    }
    expect(aborted).toBe(true);
  });

  it('对照组：已按工具归一化的 send_file（随机 url 不同）能正常累加（既有行为正确）', () => {
    const rounds = repeatRounds(5, {
      toolName: 'send_file',
      args: '{"file_path":"/tmp/a.txt"}',
      result: (index) => JSON.stringify({
        success: true,
        channel: 'DINGTALK',
        channelStatus: 'sent',
        filename: 'a.txt',
        url: `https://zos.example.com/random-${index}.txt`,
      }),
    });
    const { tail } = scanNoProgressNotices(rounds);
    expect(tail?.streak).toBe(5);
  });

  it('对照组：结果确实有语义变化时 streak 必须重置（证明不是无脑累加）', () => {
    const rounds = repeatRounds(3, {
      toolName: 'create_scheduled_task',
      args: SCHEDULED_ARGS,
      result: (index) => scheduledTaskResult(index).replace('每日报告', `每日报告${index}`),
    });
    const { tail } = scanNoProgressNotices(rounds);
    expect(tail?.streak).toBe(1);
  });

  it('修复直证：resultDigest 对两个仅 task_id 不同的结果必须给出相同摘要', () => {
    const base: NoProgressCall = { toolName: 'create_scheduled_task', argumentsJson: SCHEDULED_ARGS, resultContent: '' };
    const a = resultDigest({ ...base, resultContent: scheduledTaskResult(1) });
    const b = resultDigest({ ...base, resultContent: scheduledTaskResult(2) });
    expect(a).toBe(b); // 仅随机 id 不同 → 归一化后签名一致，streak 才能累加
  });
});
