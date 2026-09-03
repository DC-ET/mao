import { describe, expect, it } from 'vitest';
import { normalizeAskUserQuestionsArgs } from './ask-user-questions-normalize.js';

describe('normalizeAskUserQuestionsArgs', () => {
  it('正常参数：questions 为数组，字段透传', () => {
    const raw = JSON.stringify({
      questions: [
        { question: '选哪个？', header: '方案', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
      ],
      metadata: { trace: 't1' },
    });
    const { questions, metadata } = normalizeAskUserQuestionsArgs(raw);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      question: '选哪个？', header: '方案', multiSelect: false,
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
    });
    expect(metadata).toEqual({ trace: 't1' });
  });

  it('unicode 转义由 JSON.parse 自动解码', () => {
    const raw = '{"questions":[{"question":"\\u9009\\u54ea\\u4e2a\\uff1f","header":"\\u65b9\\u6848","multiSelect":false,"options":[{"label":"\\u9009\\u9879\\u4e00","description":"d"}]}]}';
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions[0].question).toBe('选哪个？');
    expect(questions[0].header).toBe('方案');
    expect((questions[0].options as Array<Record<string, unknown>>)[0].label).toBe('选项一');
  });

  it('双重编码：questions 为字符串化 JSON（线上抖动样例）', () => {
    const inner = JSON.stringify({
      questions: [{ question: '安卓端怎么处理？', header: '安卓端', multiSelect: false, options: [{ label: '隐藏（推荐）', description: '隐藏按钮' }] }],
    });
    const raw = JSON.stringify({ questions: inner });
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions).toHaveLength(1);
    expect(questions[0].header).toBe('安卓端');
    expect((questions[0].options as Array<Record<string, unknown>>)[0].label).toBe('隐藏（推荐）');
  });

  it('三重编码：questions 字符串再包两层字符串', () => {
    const inner = JSON.stringify({ questions: [{ question: 'q?', header: 'h', multiSelect: false, options: [{ label: 'a', description: 'd' }] }] });
    const raw = JSON.stringify({ questions: JSON.stringify(JSON.stringify(inner)) });
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions).toHaveLength(1);
    expect((questions[0].options as Array<Record<string, unknown>>)[0].label).toBe('a');
  });

  it('参数整体被包成 JSON 字符串字面量也能解开', () => {
    const inner = JSON.stringify({ questions: [{ question: 'q?', header: 'h', multiSelect: false, options: [{ label: 'a', description: 'd' }] }] });
    const raw = JSON.stringify(inner);
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions).toHaveLength(1);
  });

  it('options 为字符串化数组也能解开', () => {
    const raw = JSON.stringify({
      questions: [{ question: 'q?', header: 'h', multiSelect: true, options: JSON.stringify([{ label: 'a', description: 'd' }, { label: 'b', description: 'e' }]) }],
    });
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions[0].multiSelect).toBe(true);
    expect(questions[0].options).toHaveLength(2);
  });

  it('questions 包在对象里（{ questions: [...] }）', () => {
    const raw = JSON.stringify({ questions: { questions: [{ question: 'q?', header: 'h', multiSelect: false, options: [{ label: 'a', description: 'd' }] }] } });
    const { questions } = normalizeAskUserQuestionsArgs(raw);
    expect(questions).toHaveLength(1);
  });

  it('附加字段（如 id）透传，不增删改', () => {
    const raw = JSON.stringify({ questions: [{ id: 'q1' }], metadata: { source: 'test' } });
    const { questions, metadata } = normalizeAskUserQuestionsArgs(raw);
    expect(questions[0]).toEqual({ id: 'q1' });
    expect(metadata).toEqual({ source: 'test' });
  });

  it('畸形 JSON / 非对象根 / questions 为普通文本 → 空数组', () => {
    expect(normalizeAskUserQuestionsArgs('not json').questions).toEqual([]);
    expect(normalizeAskUserQuestionsArgs('[1,2]').questions).toEqual([]);
    expect(normalizeAskUserQuestionsArgs('{"questions":"just text"}').questions).toEqual([]);
    expect(normalizeAskUserQuestionsArgs('{}').questions).toEqual([]);
  });

  it('metadata 为字符串化对象时也能解开', () => {
    const raw = JSON.stringify({ questions: [{ question: 'q?', header: 'h', multiSelect: false, options: [{ label: 'a', description: 'd' }] }], metadata: '{"trace":"t1"}' });
    const { metadata } = normalizeAskUserQuestionsArgs(raw);
    expect(metadata).toEqual({ trace: 't1' });
  });
});
