import type { AskAnswer, AskQuestion } from '../ws/event-types';
import { UNICODE_SYMBOLS, type UiSymbols } from './symbols';
import type { InputController, ModalCtl } from './input-controller';
import type { ParsedKey } from './keys';

export async function askQuestionsWithController(
  input: InputController,
  questions: AskQuestion[],
  symbols: UiSymbols = UNICODE_SYMBOLS,
): Promise<AskAnswer[] | 'fail'> {
  const answers: AskAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const result = await input.runModal<AskAnswer | 'fail'>((ctl) =>
      runOneQuestion(ctl, questions[i], i, questions.length, symbols),
    );
    if (result === 'fail') return 'fail';
    answers.push(result);
  }
  return answers;
}

function runOneQuestion(
  ctl: ModalCtl,
  q: AskQuestion,
  index: number,
  total: number,
  symbols: UiSymbols,
): Promise<AskAnswer | 'fail'> {
  const options = q.options ?? [];
  let cursor = 0;
  const selected = new Set<number>();
  let customMode = options.length === 0;
  let custom = '';
  let drawnLines = 0;

  const render = () => {
    const lines: string[] = [];
    lines.push(`? Agent 想确认（${index + 1}/${total}）`);
    lines.push(`  ${q.question}`);
    if (!customMode) {
      options.forEach((opt, i) => {
        const mark = q.multiSelect ? (selected.has(i) ? '[x]' : '[ ]') : '   ';
        const pointer = i === cursor ? `${symbols.pointer} ` : '  ';
        const desc = opt.description ? ` — ${opt.description}` : '';
        lines.push(`${pointer}${mark} ${i + 1}) ${opt.label}${desc}`);
      });
      lines.push(
        q.multiSelect
          ? '  ↑↓ 选择  Space 勾选  Enter 提交  数字快捷  c 自定义  Esc 取消'
          : '  ↑↓ 选择  Enter 确认  数字快捷  c 自定义  Esc 取消',
      );
    } else {
      lines.push(`  自定义: ${custom}`);
      lines.push('  Enter 提交  Esc 返回选项 / 取消');
    }
    if (drawnLines > 0) ctl.write(`\x1b[${drawnLines}A`);
    for (const line of lines) {
      ctl.write(`\x1b[2K\r${line}\n`);
    }
    drawnLines = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (value: AskAnswer | 'fail') => {
      ctl.write('\n');
      resolve(value);
    };
    ctl.onKey((key: ParsedKey) => {
      if (key.name === 'esc' || key.name === 'ctrl-c') {
        if (customMode && options.length > 0) {
          customMode = false;
          custom = '';
          render();
          return;
        }
        finish('fail');
        return;
      }
      if (customMode) {
        if (key.name === 'enter') {
          finish({ question: q.question, selectedLabels: [], customInput: custom.trim() || undefined });
          return;
        }
        if (key.name === 'backspace') {
          custom = custom.slice(0, -1);
          render();
          return;
        }
        if (key.name === 'char' || key.name === 'digit' || key.name === 'space') {
          custom += key.raw;
          render();
        }
        return;
      }
      if (key.name === 'up') {
        cursor = (cursor - 1 + Math.max(options.length, 1)) % Math.max(options.length, 1);
        render();
        return;
      }
      if (key.name === 'down') {
        cursor = (cursor + 1) % Math.max(options.length, 1);
        render();
        return;
      }
      if (key.name === 'char' && (key.char === 'c' || key.char === 'C')) {
        customMode = true;
        custom = '';
        render();
        return;
      }
      if (key.name === 'space' && q.multiSelect) {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        render();
        return;
      }
      if (key.name === 'digit' && key.digit && key.digit <= options.length) {
        const i = key.digit - 1;
        if (q.multiSelect) {
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          cursor = i;
          render();
          return;
        }
        finish({ question: q.question, selectedLabels: [options[i].label] });
        return;
      }
      if (key.name === 'enter') {
        if (q.multiSelect) {
          const labels = [...selected].sort((a, b) => a - b).map((i) => options[i]?.label).filter(Boolean);
          finish({ question: q.question, selectedLabels: labels });
          return;
        }
        const opt = options[cursor];
        finish({ question: q.question, selectedLabels: opt ? [opt.label] : [] });
      }
    });
    render();
  });
}
