import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../src/util/exit-codes';
import { exitCodeFor } from '../src/session/session-runner';
import type { RunResult } from '../src/render/types';

function result(status: string): RunResult {
  return {
    type: 'result',
    sessionId: 1,
    executionId: 'e',
    status,
    result: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolCalls: [],
    fileChanges: [],
    durationMs: 1,
  };
}

describe('exit codes', () => {
  it('0 COMPLETED', () => {
    expect(exitCodeFor(result('COMPLETED'), { questionFailed: false, timedOut: false, interrupted: false })).toBe(EXIT.SUCCESS);
  });
  it('1 ALREADY_RUNNING / general', () => {
    expect(exitCodeFor(result('ALREADY_RUNNING'), { questionFailed: false, timedOut: false, interrupted: false })).toBe(EXIT.GENERAL);
    expect(new CliError('x').exitCode).toBe(1);
  });
  it('2 FAILED', () => {
    expect(exitCodeFor(result('FAILED'), { questionFailed: false, timedOut: false, interrupted: false })).toBe(EXIT.FAILED);
  });
  it('3 CANCELLED / interrupted', () => {
    expect(exitCodeFor(result('CANCELLED'), { questionFailed: false, timedOut: false, interrupted: true })).toBe(EXIT.CANCELLED);
    expect(exitCodeFor(result('CANCELLED'), { questionFailed: false, timedOut: false, interrupted: false })).toBe(EXIT.CANCELLED);
  });
  it('4 approval denied', () => {
    expect(exitCodeFor(result('CANCELLED'), { questionFailed: false, timedOut: false, interrupted: false, approvalFailed: true })).toBe(EXIT.APPROVAL);
    expect(EXIT.APPROVAL).toBe(4);
  });
  it('5 ask_user_questions fail', () => {
    expect(exitCodeFor(result('CANCELLED'), { questionFailed: true, timedOut: false, interrupted: false })).toBe(EXIT.QUESTION);
  });
  it('124 max-duration', () => {
    expect(exitCodeFor(result('CANCELLED'), { questionFailed: false, timedOut: true, interrupted: false })).toBe(EXIT.TIMEOUT);
    expect(EXIT.TIMEOUT).toBe(124);
  });
});
