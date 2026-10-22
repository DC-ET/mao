import { describe, expect, it, vi } from 'vitest';
import {
  observePrefix, resetPrefixFingerprint, resetPrefixMonitorForTest,
} from './prompt-prefix-monitor.js';
import type { ChatMessage, ToolDefinition } from '../llm/chat-request.js';
import * as harnessLogModule from '../log.js';

const tools: ToolDefinition[] = [
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } },
];

function sections(...entries: Array<[string, string]>): Array<{ key: string; text: string }> {
  return entries.map(([key, text]) => ({ key, text }));
}

/** 交替 user / assistant 的普通消息，够用于大多数「前缀是否变化」用例。 */
function messages(...texts: string[]): ChatMessage[] {
  return texts.map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
}

describe('PromptPrefixMonitor', () => {
  it('首次登记只打 info 且不算变化', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      const observation = observePrefix(1, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      expect(observation.firstObservation).toBe(true);
      expect(observation.changedSections).toEqual([]);
      expect(observation.toolsChanged).toBe(false);
      expect(observation.messagesChanged).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('prefix fingerprint registered session=1'));
      expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('messages=3'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('相同输入再次观察不产生 warn', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(2, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(
        2, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'),
      );
      expect(observation.changedSections).toEqual([]);
      expect(observation.toolsChanged).toBe(false);
      expect(observation.messagesChanged).toBe(false);
      expect(observation.appended).toBe(0);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('prefix changed'));
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('message prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('尾部追加消息不算前缀变化', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(3, sections(['memories', '- a\n']), tools, messages('u1', 'a1'));
      logSpy.mockClear();
      const observation = observePrefix(3, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      expect(observation.messagesChanged).toBe(false);
      expect(observation.divergedAt).toBeNull();
      expect(observation.appended).toBe(1);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('message prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('某节文本变化时点名该节', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(4, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(
        4, sections(['memories', '- a touched\n'], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'),
      );
      expect(observation.changedSections).toEqual(['memories']);
      expect(observation.toolsChanged).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('changedSections=[memories]'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('工具数组变化时报 toolsChanged', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(5, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const moreTools: ToolDefinition[] = [...tools, { type: 'function', function: { name: 'shell', parameters: {} } }];
      const observation = observePrefix(5, sections(['memories', '- a\n']), moreTools, messages('u1', 'a1', 'u2'));
      expect(observation.changedSections).toEqual([]);
      expect(observation.toolsChanged).toBe(true);
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('toolsChanged=true'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('节被移除同样算变化', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(
        6, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'),
      );
      logSpy.mockClear();
      const observation = observePrefix(6, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      expect(observation.changedSections).toEqual(['skills']);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('空 text 的节不参与指纹（与拼接口径一致）', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(7, sections(['memories', ''], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(
        7, sections(['memories', ''], ['skills', 'java\n']), tools, messages('u1', 'a1', 'u2'),
      );
      expect(observation.changedSections).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('历史中段消息被改写时点名下标与角色', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(8, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(
        8, sections(['memories', '- a\n']), tools, messages('u1', 'a1 changed', 'u2'),
      );
      expect(observation.messagesChanged).toBe(true);
      expect(observation.divergedAt).toBe(1);
      expect(observation.appended).toBe(0);
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('message prefix changed session=8'));
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('divergedAt=1'));
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('role=assistant'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('中段插入 system-notice 会告警并计数', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      const before: ChatMessage[] = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ];
      const notice: ChatMessage = {
        role: 'user',
        content: '<system-notice>\n检测到重复调用\n</system-notice>',
      };
      observePrefix(9, sections(['memories', '- a\n']), tools, before);
      logSpy.mockClear();
      const observation = observePrefix(9, sections(['memories', '- a\n']), tools, [before[0], notice, before[1], before[2]]);
      expect(observation.messagesChanged).toBe(true);
      expect(observation.tailRewrite).toBe(false);
      expect(observation.divergedAt).toBe(1);
      expect(observation.systemNotices).toBe(1);
      expect(observation.dateChangeTags).toBe(0);
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('notices=1'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('历史头部的 date-change 标签会告警并计数', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      const before: ChatMessage[] = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ];
      observePrefix(10, sections(['memories', '- a\n']), tools, before);
      logSpy.mockClear();
      const observation = observePrefix(10, sections(['memories', '- a\n']), tools, [
        {
          role: 'user',
          content: '<date-change>系统提示：当前日期已变更为 2026-10-22（星期四）。</date-change>\n\nu1',
        },
        before[1],
      ]);
      expect(observation.messagesChanged).toBe(true);
      expect(observation.divergedAt).toBe(0);
      expect(observation.dateChangeTags).toBe(1);
      expect(observation.systemNotices).toBe(0);
      expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('dateTags=1'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('只重写上一轮最后一条消息时按尾部重写处理，不按中段变化告警', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(15, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(15, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2 retried'));
      expect(observation.messagesChanged).toBe(true);
      expect(observation.tailRewrite).toBe(true);
      expect(observation.divergedAt).toBe(2);
      expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('message prefix tail rewritten session=15'));
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('message prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('消息被截断只打 info，不按中段变化告警', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(11, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      const observation = observePrefix(11, sections(['memories', '- a\n']), tools, messages('u1', 'a1'));
      expect(observation.messagesChanged).toBe(false);
      expect(observation.divergedAt).toBeNull();
      expect(observation.appended).toBe(-1);
      expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('message prefix truncated session=11'));
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('message prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('会话间互不干扰', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(12, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      logSpy.mockClear();
      // 会话 13 首次登记不 Warn；会话 12 相同输入也不 Warn
      const other = observePrefix(13, sections(['memories', '- b\n']), tools, messages('u1', 'a1', 'u2'));
      const same = observePrefix(12, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      expect(other.firstObservation).toBe(true);
      expect(same.changedSections).toEqual([]);
      expect(same.messagesChanged).toBe(false);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('resetPrefixFingerprint 后重新登记（不误报变化）', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(14, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      resetPrefixFingerprint(14);
      logSpy.mockClear();
      const observation = observePrefix(14, sections(['memories', '- a\n']), tools, messages('u1', 'a1', 'u2'));
      expect(observation.firstObservation).toBe(true);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('超过 512 会话按插入序淘汰最旧，不泄漏', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      for (let i = 1; i <= 600; i++) {
        observePrefix(i, sections(['memories', `- m${i}\n`]), tools, messages('u1'));
      }
      // 最早登记的会话 1 已被淘汰：再次观察按「首次登记」处理，不会拿陈旧快照误报
      const evicted = observePrefix(1, sections(['memories', '- m1\n']), tools, messages('u1'));
      expect(evicted.firstObservation).toBe(true);
      // 仍在表内的会话 600 相同输入不变化
      const kept = observePrefix(600, sections(['memories', '- m600\n']), tools, messages('u1'));
      expect(kept.firstObservation).toBe(false);
      expect(kept.changedSections).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});
