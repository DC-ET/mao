import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import type { WsAskUserQuestionAnswer } from '@mao/contracts';
import QuestionCard from './QuestionCard.vue';
import type { PendingQuestion } from '../types';

/** 无 @vue/test-utils：直接用 createApp 挂到临时容器（happy-dom） */
let app: App | null = null;
let container: HTMLDivElement | null = null;

function mount(pending: PendingQuestion, submitting = false) {
  const submitted: Array<{ requestId: string; answers: WsAskUserQuestionAnswer[] }> = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(QuestionCard, {
        pending,
        submitting,
        onSubmit: (requestId: string, answers: WsAskUserQuestionAnswer[]) =>
          submitted.push({ requestId, answers }),
      }),
  });
  app.mount(container);
  return { submitted, el: container };
}

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
});

function click(el: Element | null) {
  (el as HTMLElement | null)?.click();
}

describe('QuestionCard', () => {
  const single: PendingQuestion = {
    requestId: 'rq1',
    questions: [
      {
        question: '选一个方案',
        header: '方案',
        multiSelect: false,
        options: [{ label: 'A', description: '甲' }, { label: 'B' }],
      },
    ],
  };

  it('单选题渲染 radio，多选题渲染 checkbox', () => {
    const { el } = mount(single);
    const inputs = [...el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    expect(inputs.map((i) => i.type)).toEqual(['radio', 'radio']);
    app?.unmount();
    app = null;
    el.remove();

    const multi: PendingQuestion = {
      requestId: 'rq2',
      questions: [{ question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    };
    const m = mount(multi);
    const mInputs = [...m.el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    expect(mInputs.map((i) => i.type)).toEqual(['checkbox', 'checkbox']);
  });

  it('提交的 answers 形状匹配工具 outputSchema', async () => {
    const { submitted, el } = mount(single);
    const inputs = [...el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event('change'));
    await nextTick();
    click(el.querySelector('.mao-btn--primary'));
    expect(submitted).toEqual([
      { requestId: 'rq1', answers: [{ question: '选一个方案', selectedLabels: ['B'], customInput: null }] },
    ]);
  });

  it('单选互斥：选第二项后第一项取消', async () => {
    const { submitted, el } = mount(single);
    const inputs = [...el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    inputs[0].dispatchEvent(new Event('change'));
    await nextTick();
    inputs[1].dispatchEvent(new Event('change'));
    await nextTick();
    click(el.querySelector('.mao-btn--primary'));
    expect(submitted[0].answers[0].selectedLabels).toEqual(['B']);
  });

  it('多选可累积选择', async () => {
    const multi: PendingQuestion = {
      requestId: 'rq3',
      questions: [{ question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    };
    const { submitted, el } = mount(multi);
    const inputs = [...el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    inputs[0].dispatchEvent(new Event('change'));
    await nextTick();
    inputs[1].dispatchEvent(new Event('change'));
    await nextTick();
    click(el.querySelector('.mao-btn--primary'));
    expect(submitted[0].answers[0].selectedLabels).toEqual(['A', 'B']);
  });

  it('仅填写 customInput 也可提交', async () => {
    const { submitted, el } = mount(single);
    const custom = el.querySelector('.mao-q__custom') as HTMLInputElement;
    custom.value = '我想要方案 C';
    custom.dispatchEvent(new Event('input'));
    await nextTick();
    click(el.querySelector('.mao-btn--primary'));
    expect(submitted[0].answers[0]).toEqual({
      question: '选一个方案',
      selectedLabels: [],
      customInput: '我想要方案 C',
    });
  });

  it('未作答时提交按钮禁用', () => {
    const { el } = mount(single);
    const btn = el.querySelector('.mao-btn--primary') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('submitting 时按钮禁用且不再触发提交', async () => {
    const { submitted, el } = mount(single, true);
    const inputs = [...el.querySelectorAll('.mao-q__opt input')] as HTMLInputElement[];
    inputs[0].dispatchEvent(new Event('change'));
    await nextTick();
    const btn = el.querySelector('.mao-btn--primary') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('已提交');
    expect(submitted).toHaveLength(0);
  });
});
