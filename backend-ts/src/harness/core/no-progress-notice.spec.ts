import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/chat-request.js';
import type { ToolAttachment } from './tool-attachment.js';
import {
  NO_PROGRESS_ABORT_AT,
  NO_PROGRESS_EXEMPT_TOOLS,
  NO_PROGRESS_NUDGE_AT,
  applyNoProgressNotices,
  buildNoProgressNotice,
  canonicalArgs,
  isNoProgressExempt,
  resultDigest,
  roundSignature,
  scanNoProgressNotices,
  shortHash,
} from './no-progress-notice.js';

const GREP_ARGS = '{"pattern":"群名","path":"backend-ts/src/feishu"}';
const GREP_EMPTY = '{"total_matches":0,"matches":[]}';

function roundMessages(
  ids: string[],
  options: { toolName?: string; args?: string; result?: string } = {},
): ChatMessage[] {
  const toolName = options.toolName ?? 'grep_search';
  const args = options.args ?? GREP_ARGS;
  const result = options.result ?? GREP_EMPTY;
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: ids.map((id) => ({ id, type: 'function', function: { name: toolName, arguments: args } })),
    },
    ...ids.map((id) => ({ role: 'tool', toolCallId: id, content: result })),
  ];
}

function repeatRounds(count: number, prefix: string, options: Parameters<typeof roundMessages>[1] = {}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= count; i++) messages.push(...roundMessages([`${prefix}-${i}`], options));
  return messages;
}

describe('no-progress-notice', () => {
  describe('canonicalArgs', () => {
    it('sorts object keys so gateway key order does not create a fake difference', () => {
      expect(canonicalArgs('{"b":1,"a":{"d":2,"c":3}}'))
        .toBe(canonicalArgs('{"a":{"c":3,"d":2},"b":1}'));
    });

    it('keeps array order and collapses whitespace for non-JSON input', () => {
      expect(canonicalArgs('  git   status\n  --short  ')).toBe('git status --short');
      expect(canonicalArgs('["a","b"]')).toBe('["a","b"]');
      expect(canonicalArgs('["b","a"]')).not.toBe(canonicalArgs('["a","b"]'));
    });
  });

  describe('resultDigest', () => {
    const shellResult = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
      exit_code: 0,
      session_id: 'sh-1',
      output: 'done\n',
      truncated: false,
      completed: true,
      current_workdir: '/repo',
      output_file: 'sh-1.out',
      ...overrides,
    });

    function shellCall(result: string, args = '{"command":"npm test"}'): Parameters<typeof resultDigest>[0] {
      return { toolName: 'shell', argumentsJson: args, resultContent: result };
    }

    it('ignores session_id / output_file so the 2207 loop still matches', () => {
      const first = shellCall(shellResult());
      const second = shellCall(shellResult({ session_id: 'sh-2', output_file: 'sh-2.out' }));
      expect(resultDigest(second)).toBe(resultDigest(first));
    });

    it('ignores the per-session wait hint on incomplete results', () => {
      const pending = (sessionId: string): string => JSON.stringify({
        exit_code: -1,
        session_id: sessionId,
        output: '',
        truncated: false,
        completed: false,
        current_workdir: '/repo',
        output_file: `${sessionId}.out`,
        message: `等待超时，命令仍在运行。用 action:'await_async' + session_id:'${sessionId}' 继续等待。`,
      });
      expect(resultDigest(shellCall(pending('sh-a')))).toBe(resultDigest(shellCall(pending('sh-b'))));
    });

    it('treats semantic shell fields as real progress', () => {
      expect(resultDigest(shellCall(shellResult({ output: 'changed\n' })))).not.toBe(resultDigest(shellCall(shellResult())));
      expect(resultDigest(shellCall(shellResult({ exit_code: 1 })))).not.toBe(resultDigest(shellCall(shellResult())));
      expect(resultDigest(shellCall(shellResult({ completed: false })))).not.toBe(resultDigest(shellCall(shellResult())));
      expect(resultDigest(shellCall(shellResult({ current_workdir: '/tmp' })))).not.toBe(resultDigest(shellCall(shellResult())));
    });

    it('drops registered volatile fields for generic tools but keeps semantic ids', () => {
      const base = { execution_id: 'e1', timestamp: 1710000000, data: { total_matches: 0 } };
      const other = { execution_id: 'e2', timestamp: 1710000099, data: { total_matches: 0 } };
      const call = (value: unknown): Parameters<typeof resultDigest>[0] => ({
        toolName: 'grep_search', argumentsJson: GREP_ARGS, resultContent: JSON.stringify(value),
      });
      expect(resultDigest(call(other))).toBe(resultDigest(call(base)));
      expect(resultDigest(call({ child_session_id: 11, task_id: 1 })))
        .not.toBe(resultDigest(call({ child_session_id: 12, task_id: 1 })));
    });

    it('includes image bytes so a refreshed file at the same path is progress', () => {
      const base = { media_type: 'image', path: '/tmp/a.png', width: 10, height: 10 };
      const call = (dataUri: string): { toolName: string; argumentsJson: string; resultContent: string; attachment: ToolAttachment } => ({
        toolName: 'read_file',
        argumentsJson: '{"path":"/tmp/a.png"}',
        resultContent: JSON.stringify(base),
        attachment: { mime: 'image/png', path: '/tmp/a.png', dataUri },
      });
      expect(resultDigest(call('data:image/png;base64,AAA'))).not.toBe(resultDigest(call('data:image/png;base64,BBB')));
      expect(resultDigest(call('data:image/png;base64,AAA'))).toBe(resultDigest(call('data:image/png;base64,AAA')));
    });

    it('ignores trailing whitespace on non-JSON results', () => {
      const call = (content: string): Parameters<typeof resultDigest>[0] => ({
        toolName: 'mcp_call', argumentsJson: '{}', resultContent: content,
      });
      expect(resultDigest(call('plain text\n\n'))).toBe(resultDigest(call('plain text')));
    });
  });

  describe('exemptions', () => {
    afterEach(() => {
      NO_PROGRESS_EXEMPT_TOOLS.clear();
    });

    it('exempts shell wait actions and incomplete results', () => {
      expect(isNoProgressExempt({
        toolName: 'shell', argumentsJson: '{"action":"await_async","session_id":"sh-1"}', resultContent: '{}',
      })).toBe(true);
      expect(isNoProgressExempt({
        toolName: 'shell', argumentsJson: '{"action":"write_stdin","session_id":"sh-1","input":"y"}', resultContent: '{}',
      })).toBe(true);
      expect(isNoProgressExempt({
        toolName: 'shell', argumentsJson: '{"command":"sleep 5"}', resultContent: '{"completed":false}',
      })).toBe(true);
      expect(isNoProgressExempt({
        toolName: 'shell', argumentsJson: '{"command":"npm test"}', resultContent: '{"completed":true,"exit_code":0}',
      })).toBe(false);
    });

    it('exempts timed-out wait_subagents (snake_case payload)', () => {
      expect(isNoProgressExempt({
        toolName: 'wait_subagents', argumentsJson: '{}', resultContent: '{"completed":0,"timed_out":true}',
      })).toBe(true);
      expect(isNoProgressExempt({
        toolName: 'wait_subagents', argumentsJson: '{}', resultContent: '{"completed":1,"timed_out":false}',
      })).toBe(false);
    });

    it('honours the tool-level exemption set', () => {
      NO_PROGRESS_EXEMPT_TOOLS.add('task_list');
      expect(isNoProgressExempt({ toolName: 'task_list', argumentsJson: '{}', resultContent: '' })).toBe(true);
    });
  });

  describe('buildNoProgressNotice', () => {
    it('renders the two documented templates without leaking arguments', () => {
      const first = buildNoProgressNotice(NO_PROGRESS_NUDGE_AT[0], ['grep_search']);
      expect(first).toContain('最近 5 轮的工具调用与结果完全一致（工具：grep_search）');
      expect(first).not.toContain('群名');
      const second = buildNoProgressNotice(NO_PROGRESS_NUDGE_AT[1], ['grep_search']);
      expect(second).toContain(`系统将在第 ${NO_PROGRESS_ABORT_AT} 轮自动中止本次执行`);
    });
  });

  describe('roundSignature', () => {
    it('ignores canonical key order but keeps call order', () => {
      const a = { toolName: 'grep_search', argumentsJson: '{"a":1,"b":2}', resultContent: GREP_EMPTY };
      const b = { toolName: 'grep_search', argumentsJson: '{"b":2,"a":1}', resultContent: GREP_EMPTY };
      const c = { toolName: 'glob_search', argumentsJson: '{"a":1,"b":2}', resultContent: GREP_EMPTY };
      expect(roundSignature([a])).toBe(roundSignature([b]));
      expect(roundSignature([a, c])).not.toBe(roundSignature([c, a]));
    });
  });

  describe('scanNoProgressNotices', () => {
    it('emits one notice after 5 identical rounds and reports the tail', () => {
      const messages = repeatRounds(5, 'r');
      const { notices, tail } = scanNoProgressNotices(messages);
      expect(notices).toHaveLength(1);
      expect(notices[0].afterToolCallId).toBe('r-5');
      expect(notices[0].text).toContain('最近 5 轮');
      expect(tail).toEqual(expect.objectContaining({ streak: 5, nudgedAt: [5] }));
    });

    it('emits the second notice at 10 and keeps counting to 15', () => {
      const { notices, tail } = scanNoProgressNotices(repeatRounds(15, 'r'));
      expect(notices.map((notice) => notice.afterToolCallId)).toEqual(['r-5', 'r-10']);
      expect(notices[1].text).toContain(`第 ${NO_PROGRESS_ABORT_AT} 轮自动中止`);
      expect(tail).toEqual(expect.objectContaining({ streak: 15, nudgedAt: [5, 10] }));
    });

    it('resets on a changed result and does not emit notices for 3 different rounds', () => {
      const messages = [
        ...roundMessages(['r-1'], { result: '{"total_matches":0,"matches":[]}' }),
        ...roundMessages(['r-2'], { result: '{"total_matches":1,"matches":[1]}' }),
        ...roundMessages(['r-3'], { result: '{"total_matches":0,"matches":[]}' }),
      ];
      const { notices, tail } = scanNoProgressNotices(messages);
      expect(notices).toHaveLength(0);
      expect(tail).toEqual(expect.objectContaining({ streak: 1 }));
    });

    it('matches whole-round signatures: [A,B] repeated hits, [A,B] vs [B,A] does not', () => {
      const twoCallRound = (index: number, swapped: boolean): ChatMessage[] => {
        const calls = [
          { id: `a-${index}`, args: '{"path":"a"}', result: '{"total_matches":0}' },
          { id: `b-${index}`, args: '{"path":"b"}', result: '{"total_matches":2}' },
        ];
        const ordered = swapped ? [calls[1], calls[0]] : calls;
        return [
          {
            role: 'assistant',
            content: '',
            toolCalls: ordered.map((item) => ({ id: item.id, function: { name: 'grep_search', arguments: item.args } })),
          },
          ...ordered.map((item) => ({ role: 'tool', toolCallId: item.id, content: item.result })),
        ];
      };

      const same: ChatMessage[] = [];
      for (let i = 1; i <= 5; i++) same.push(...twoCallRound(i, false));
      const hit = scanNoProgressNotices(same);
      expect(hit.notices).toHaveLength(1);
      expect(hit.notices[0].afterToolCallId).toBe('b-5');

      const alternating: ChatMessage[] = [];
      for (let i = 1; i <= 6; i++) alternating.push(...twoCallRound(i, i % 2 === 0));
      expect(scanNoProgressNotices(alternating).notices).toHaveLength(0);
    });

    it('does not flag A/B round alternation (known narrow scope)', () => {
      const messages: ChatMessage[] = [];
      for (let i = 1; i <= 8; i++) {
        messages.push(...roundMessages([`r-${i}`], { result: i % 2 === 0 ? '{"n":2}' : '{"n":1}' }));
      }
      expect(scanNoProgressNotices(messages).notices).toHaveLength(0);
    });

    it('resets on a real user message boundary', () => {
      const messages = [
        ...repeatRounds(5, 'r'),
        { role: 'user', content: '再试一次' },
        ...repeatRounds(4, 's'),
      ];
      const { notices, tail } = scanNoProgressNotices(messages);
      expect(notices).toHaveLength(1);
      expect(notices[0].afterToolCallId).toBe('r-5');
      expect(tail).toEqual(expect.objectContaining({ streak: 4 }));
    });

    it('skips incomplete rounds without advancing or resetting the streak', () => {
      const messages = [
        ...repeatRounds(4, 'r'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'orphan', function: { name: 'grep_search', arguments: GREP_ARGS } }] },
        ...roundMessages(['s-1']),
      ];
      // 孤儿轮整轮跳过：既不推进也不重置，下一次相同调用即第 5 轮
      const { notices, tail } = scanNoProgressNotices(messages);
      expect(notices).toHaveLength(1);
      expect(notices[0].afterToolCallId).toBe('s-1');
      expect(tail).toEqual(expect.objectContaining({ streak: 5 }));
    });

    it('resets when a whole round consists of exempt calls', () => {
      const waitRound = (id: string): ChatMessage[] => roundMessages([id], {
        toolName: 'shell',
        args: '{"action":"await_async","session_id":"sh-1"}',
        result: '{"completed":false,"session_id":"sh-1"}',
      });
      const messages = [...repeatRounds(4, 'r'), ...waitRound('w-1'), ...repeatRounds(4, 's')];
      const { notices, tail } = scanNoProgressNotices(messages);
      expect(notices).toHaveLength(0);
      expect(tail).toEqual(expect.objectContaining({ streak: 4 }));
    });

    it('uses attachments from the same map as the runtime guard for image digests', () => {
      const messages = repeatRounds(5, 'img', { toolName: 'read_file' });
      const attachment = (dataUri: string): Map<string, ToolAttachment> => new Map(
        ['img-1', 'img-2', 'img-3', 'img-4', 'img-5'].map((id) => [id, { mime: 'image/png', dataUri }]),
      );
      expect(scanNoProgressNotices(messages, attachment('data:image/png;base64,AAA')).notices).toHaveLength(1);
      const refreshed = new Map<string, ToolAttachment>(
        ['img-2', 'img-3', 'img-4', 'img-5'].map((id) => [id, { mime: 'image/png', dataUri: 'data:image/png;base64,BBB' }]),
      );
      refreshed.set('img-1', { mime: 'image/png', dataUri: 'data:image/png;base64,AAA' });
      expect(scanNoProgressNotices(messages, refreshed).notices).toHaveLength(0);
    });

    it('returns a null tail when the window has no tool round', () => {
      expect(scanNoProgressNotices([{ role: 'user', content: 'hi' }])).toEqual({ notices: [], tail: null });
    });
  });

  describe('applyNoProgressNotices', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...repeatRounds(2, 'r'),
      { role: 'user', content: 'next' },
    ];

    it('inserts the notice right after the anchor tool message', () => {
      const rendered = applyNoProgressNotices(messages, [{ afterToolCallId: 'r-2', text: 'hello' }]);
      expect(rendered).toHaveLength(messages.length + 1);
      const anchorIndex = rendered.findIndex((m) => m.toolCallId === 'r-2');
      expect(rendered[anchorIndex + 1]).toEqual({ role: 'user', content: '<system-notice>\nhello\n</system-notice>' });
    });

    it('is pure and idempotent for the same input', () => {
      const notice = [{ afterToolCallId: 'r-2', text: 'hello' }];
      const first = applyNoProgressNotices(messages, notice);
      const second = applyNoProgressNotices(messages, notice);
      expect(second).toEqual(first);
      expect(messages).toHaveLength(6);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      // 入参数组与消息对象都不被改写
      expect(messages[4]).toEqual({ role: 'tool', toolCallId: 'r-2', content: GREP_EMPTY });
    });

    it('does not duplicate the notice when applied to already rendered output', () => {
      const notice = [{ afterToolCallId: 'r-2', text: 'hello' }];
      const once = applyNoProgressNotices(messages, notice);
      expect(applyNoProgressNotices(once, notice)).toEqual(once);
    });

    it('skips missing anchors without throwing', () => {
      expect(() => applyNoProgressNotices(messages, [{ afterToolCallId: 'missing', text: 'x' }])).not.toThrow();
      expect(applyNoProgressNotices(messages, [{ afterToolCallId: 'missing', text: 'x' }])).toHaveLength(6);
    });

    it('keeps the notice between the tool group and later synthetic media messages', () => {
      const withMedia: ChatMessage[] = [
        ...roundMessages(['r-1']),
        { role: 'user', content: [{ type: 'text', text: 'Attached media from tool result:' }] },
        ...roundMessages(['r-2']),
      ];
      const rendered = applyNoProgressNotices(withMedia, [{ afterToolCallId: 'r-1', text: 'x' }]);
      expect(rendered[2]).toEqual({ role: 'user', content: '<system-notice>\nx\n</system-notice>' });
      expect(rendered[3]).toEqual(withMedia[2]);
    });
  });

  it('shortHash is stable and 16 hex chars long', () => {
    expect(shortHash('abc')).toHaveLength(16);
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});
