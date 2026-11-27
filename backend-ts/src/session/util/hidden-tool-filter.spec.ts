import { describe, expect, it } from 'vitest';
import {
  filterHiddenToolNamesJson,
  filterUserHiddenToolMessages,
  stripHiddenToolPromptSection,
} from './hidden-tool-filter.js';
import type { Message } from '../types.js';

function msg(overrides: Partial<Message>): Message {
  return { id: 1, role: 'USER', ...overrides } as Message;
}

const ASSISTANT_WITH_REPORT = msg({
  id: 10,
  role: 'ASSISTANT',
  content: '',
  toolCalls: JSON.stringify([
    { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
    { id: 'call_2', type: 'function', function: { name: 'report_issue', arguments: '{"category":"tool_defect","title":"x"}' } },
  ]),
});

describe('filterUserHiddenToolMessages', () => {
  it('隐藏工具的 toolCalls 条目与对应 TOOL 行成对移除，其他工具不受影响', () => {
    const toolOk = msg({ id: 11, role: 'TOOL', toolCallId: 'call_1', content: '{"ok":true}' });
    const toolHidden = msg({ id: 12, role: 'TOOL', toolCallId: 'call_2', content: '{"received":true}' });
    const out = filterUserHiddenToolMessages([ASSISTANT_WITH_REPORT, toolOk, toolHidden]);
    expect(out).toHaveLength(2);
    const assistant = out[0];
    const calls = JSON.parse(assistant.toolCalls!) as Array<{ id: string; function: { name: string } }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_1');
    expect(out.map((m) => m.id)).toEqual([10, 11]);
  });

  it('只含隐藏调用的空助手中间消息整条移除（与桌面端 task_* 过滤后为空即跳过同口径）', () => {
    const assistantOnlyReport = msg({
      id: 20,
      role: 'ASSISTANT',
      content: '',
      toolCalls: JSON.stringify([
        { id: 'call_9', type: 'function', function: { name: 'report_issue', arguments: '{}' } },
      ]),
    });
    const toolHidden = msg({ id: 21, role: 'TOOL', toolCallId: 'call_9', content: '{"received":true}' });
    const out = filterUserHiddenToolMessages([assistantOnlyReport, toolHidden]);
    expect(out).toEqual([]);
  });

  it('剥掉隐藏调用但仍有正文的助手消息保留（正文不丢）', () => {
    const assistant = msg({
      id: 10,
      role: 'ASSISTANT',
      content: '好的，我继续完成任务。',
      toolCalls: JSON.stringify([
        { id: 'call_2', type: 'function', function: { name: 'report_issue', arguments: '{}' } },
      ]),
    });
    const toolHidden = msg({ id: 11, role: 'TOOL', toolCallId: 'call_2', content: '{}' });
    const out = filterUserHiddenToolMessages([assistant, toolHidden]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('好的，我继续完成任务。');
    expect(out[0].toolCalls).toBeNull();
  });

  it('零命中零拷贝：无隐藏工具的页面返回原数组引用（含原本就空的助手消息不误伤）', () => {
    const blankAssistant = msg({ id: 30, role: 'ASSISTANT', content: '', toolCalls: null });
    const input = [msg({ id: 1 }), blankAssistant];
    const out = filterUserHiddenToolMessages(input);
    expect(out).toBe(input);
  });

  it('toolCalls JSON 解析失败原样保留（不吞消息）', () => {
    const broken = msg({ id: 40, role: 'ASSISTANT', content: 'x', toolCalls: '{broken' });
    const out = filterUserHiddenToolMessages([broken]);
    expect(out).toHaveLength(1);
    expect(out[0].toolCalls).toBe('{broken');
  });

  it('TOOL 行的 toolCallId 未被本页收集时不删（跨页历史防御）', () => {
    // 隐藏调用的声明消息在更早的分页里：本页只有孤儿 TOOL 行。
    // 按成对删除口径不删它——声明不在本页则按 id 无法归因，保留比误删安全。
    const orphanTool = msg({ id: 50, role: 'TOOL', toolCallId: 'call_unknown', content: '{}' });
    const withReport = msg({
      id: 51,
      role: 'ASSISTANT',
      content: '文字',
      toolCalls: JSON.stringify([
        { id: 'call_2', type: 'function', function: { name: 'report_issue', arguments: '{}' } },
      ]),
    });
    const out = filterUserHiddenToolMessages([orphanTool, withReport]);
    expect(out.map((m) => m.id)).toEqual([50, 51]);
  });
});

describe('stripHiddenToolPromptSection', () => {
  const prompt = '## 任务管理\n\n任务内容。\n\n## 问题上报\n\n你可以使用 report_issue 工具。\n\n规则：\n- 保密\n\n## 其他\n\n其他内容。';

  it('剥离「问题上报」节，保留前后节', () => {
    const out = stripHiddenToolPromptSection(prompt)!;
    expect(out).toContain('## 任务管理');
    expect(out).toContain('## 其他');
    expect(out).not.toContain('问题上报');
    expect(out).not.toContain('report_issue');
  });

  it('节在末尾（$ 锚定）与和前节粘合两种形态都能剥', () => {
    const tail = stripHiddenToolPromptSection('## 任务管理\n\nx\n\n## 问题上报\n\n上报内容。\n\n')!;
    expect(tail).not.toContain('report_issue');
    expect(tail).toContain('## 任务管理');
    const glued = stripHiddenToolPromptSection('前文结尾。## 问题上报\n\n上报内容。\n\n## 下一节\n\ny')!;
    expect(glued).toContain('前文结尾。');
    expect(glued).toContain('## 下一节');
    expect(glued).not.toContain('问题上报');
  });

  it('无该节时原样返回（含 null）', () => {
    expect(stripHiddenToolPromptSection('## 任务管理\n\nx')).toBe('## 任务管理\n\nx');
    expect(stripHiddenToolPromptSection(null)).toBeNull();
  });
});

describe('filterHiddenToolNamesJson', () => {
  it('从工具名清单删除隐藏工具名，全删光归 null', () => {
    expect(filterHiddenToolNamesJson('["shell","report_issue","read_file"]')).toBe('["shell","read_file"]');
    expect(filterHiddenToolNamesJson('["report_issue"]')).toBeNull();
  });

  it('无隐藏名 / 解析失败 / null 原样返回', () => {
    expect(filterHiddenToolNamesJson('["shell"]')).toBe('["shell"]');
    expect(filterHiddenToolNamesJson('not json')).toBe('not json');
    expect(filterHiddenToolNamesJson(null)).toBeNull();
  });
});
