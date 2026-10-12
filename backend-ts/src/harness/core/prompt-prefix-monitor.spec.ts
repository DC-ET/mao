import { describe, expect, it, vi } from 'vitest';
import {
  observePrefix, resetPrefixFingerprint, resetPrefixMonitorForTest,
} from './prompt-prefix-monitor.js';
import type { ToolDefinition } from '../llm/chat-request.js';
import * as harnessLogModule from '../log.js';

const tools: ToolDefinition[] = [
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } },
];

function sections(...entries: Array<[string, string]>): Array<{ key: string; text: string }> {
  return entries.map(([key, text]) => ({ key, text }));
}

describe('PromptPrefixMonitor', () => {
  it('首次登记只打 info 且不算变化', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      const observation = observePrefix(1, sections(['memories', '- a\n']), tools, 3);
      expect(observation.firstObservation).toBe(true);
      expect(observation.changedSections).toEqual([]);
      expect(observation.toolsChanged).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('prefix fingerprint registered session=1'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('相同输入再次观察不产生 warn', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(2, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, 3);
      logSpy.mockClear();
      const observation = observePrefix(2, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, 5);
      expect(observation.changedSections).toEqual([]);
      expect(observation.toolsChanged).toBe(false);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('某节文本变化时点名该节', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(3, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, 3);
      logSpy.mockClear();
      const observation = observePrefix(3, sections(['memories', '- a touched\n'], ['skills', 'java\n']), tools, 3);
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
      observePrefix(4, sections(['memories', '- a\n']), tools, 3);
      logSpy.mockClear();
      const moreTools: ToolDefinition[] = [...tools, { type: 'function', function: { name: 'shell', parameters: {} } }];
      const observation = observePrefix(4, sections(['memories', '- a\n']), moreTools, 3);
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
      observePrefix(5, sections(['memories', '- a\n'], ['skills', 'java\n']), tools, 3);
      logSpy.mockClear();
      const observation = observePrefix(5, sections(['memories', '- a\n']), tools, 3);
      expect(observation.changedSections).toEqual(['skills']);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('空 text 的节不参与指纹（与拼接口径一致）', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(6, sections(['memories', ''], ['skills', 'java\n']), tools, 3);
      logSpy.mockClear();
      const observation = observePrefix(6, sections(['memories', ''], ['skills', 'java\n']), tools, 3);
      expect(observation.changedSections).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('会话间互不干扰', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(7, sections(['memories', '- a\n']), tools, 3);
      logSpy.mockClear();
      // 会话 8 首次登记不 Warn；会话 7 相同输入也不 Warn
      const other = observePrefix(8, sections(['memories', '- b\n']), tools, 3);
      const same = observePrefix(7, sections(['memories', '- a\n']), tools, 3);
      expect(other.firstObservation).toBe(true);
      expect(same.changedSections).toEqual([]);
      expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('prefix changed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('resetPrefixFingerprint 后重新登记（不误报变化）', () => {
    resetPrefixMonitorForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      observePrefix(9, sections(['memories', '- a\n']), tools, 3);
      resetPrefixFingerprint(9);
      logSpy.mockClear();
      const observation = observePrefix(9, sections(['memories', '- a\n']), tools, 3);
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
        observePrefix(i, sections(['memories', `- m${i}\n`]), tools, 1);
      }
      // 最早登记的会话 1 已被淘汰：再次观察按「首次登记」处理，不会拿陈旧快照误报
      const evicted = observePrefix(1, sections(['memories', '- m1\n']), tools, 1);
      expect(evicted.firstObservation).toBe(true);
      // 仍在表内的会话 600 相同输入不变化
      const kept = observePrefix(600, sections(['memories', '- m600\n']), tools, 1);
      expect(kept.firstObservation).toBe(false);
      expect(kept.changedSections).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});
