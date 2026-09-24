/** 与桌面端 QuestionPanel 提交形状一致。空的自定义文本用 null。 */
export interface FeishuAskAnswer {
  question: string;
  selectedLabels: string[];
  customInput: string | null;
}

export type FeishuAskMapResult = { ok: true; answers: FeishuAskAnswer[] } | { ok: false };

/** 交互组件 name 在整张卡片内必须唯一，所以带上 form 序号，不能每组都从 q0/c0/submit 重来。 */
export function feishuAskSelectName(formIndex: number, questionIndex: number): string {
  return `q${formIndex}_${questionIndex}`;
}

export function feishuAskCustomName(formIndex: number, questionIndex: number): string {
  return `c${formIndex}_${questionIndex}`;
}

export function feishuAskSubmitName(formIndex: number): string {
  return `submit_${formIndex}`;
}

/**
 * 把飞书 form_value 映射成 ask_user_questions 的答案。
 * 单选：自定义文本去空白后非空时忽略下拉（对齐桌面端填写「其他」会清掉选项）。
 * 多选：选项与自定义文本同时保留。
 * 任一一题两项都空则整单拒绝，不调用 complete。
 */
export function mapFeishuAskAnswers(
  questions: Array<Record<string, unknown>>,
  formValue: Record<string, unknown> | null | undefined,
  actionName?: string,
): FeishuAskMapResult {
  if (questions.length === 0) return { ok: false };
  const value = formValue ?? {};
  const formIndex = resolveFormIndex(value, actionName);
  const answers: FeishuAskAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const custom = customText(readField(value, formIndex, i, 'c'));
    if (question.multiSelect === true) {
      const selectedLabels = rawSelections(readField(value, formIndex, i, 'q'))
        .map((raw) => optionLabel(question, parseIndex(raw)))
        .filter((label): label is string => label != null);
      if (selectedLabels.length === 0 && custom === '') return { ok: false };
      answers.push({
        question: questionText(question),
        selectedLabels,
        customInput: custom === '' ? null : custom,
      });
      continue;
    }
    if (custom !== '') {
      answers.push({ question: questionText(question), selectedLabels: [], customInput: custom });
      continue;
    }
    const label = optionLabel(question, parseIndex(singleSelection(readField(value, formIndex, i, 'q'))));
    if (label == null) return { ok: false };
    answers.push({ question: questionText(question), selectedLabels: [label], customInput: null });
  }
  return { ok: true, answers };
}

function resolveFormIndex(value: Record<string, unknown>, actionName?: string): number {
  for (const key of Object.keys(value)) {
    const match = /^(?:q|c)(\d+)_\d+$/.exec(key);
    if (match) return Number(match[1]);
  }
  const named = /^(?:ask|submit)_(\d+)$/.exec(actionName ?? '');
  return named ? Number(named[1]) : 0;
}

/** 优先读带 form 序号的字段；没有这种字段时再认 q0/c0，兼容只挂一组时的回调。 */
function readField(value: Record<string, unknown>, formIndex: number, questionIndex: number, kind: 'q' | 'c'): unknown {
  const prefixed = value[kind === 'q' ? feishuAskSelectName(formIndex, questionIndex) : feishuAskCustomName(formIndex, questionIndex)];
  if (prefixed !== undefined) return prefixed;
  if (Object.keys(value).some((key) => /^(?:q|c)\d+_\d+$/.test(key))) return undefined;
  return value[`${kind}${questionIndex}`];
}

function questionText(question: Record<string, unknown>): string {
  return typeof question.question === 'string' ? question.question : '';
}

function customText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function singleSelection(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

function rawSelections(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch { /* 当作单个下标 */ }
    }
    return trimmed === '' ? [] : [trimmed];
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  return [];
}

function parseIndex(value: unknown): number | null {
  const raw = unwrapSelection(value);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** 部分客户端把选项回传成 { value: "0" }，而不是下标字符串。 */
function unwrapSelection(value: unknown): unknown {
  if (value != null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function optionLabel(question: Record<string, unknown>, index: number | null): string | null {
  if (index == null) return null;
  const options = question.options;
  if (!Array.isArray(options)) return null;
  const option = options[index];
  if (option == null || typeof option !== 'object') return null;
  const label = (option as { label?: unknown }).label;
  return typeof label === 'string' && label !== '' ? label : null;
}
