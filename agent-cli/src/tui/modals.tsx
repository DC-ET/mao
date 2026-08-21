import React, { useState, useRef, useCallback } from 'react';
import { useInput, useApp, Text } from 'ink';
import type { AskAnswer, AskQuestion } from '../ws/event-types';
import { UNICODE_SYMBOLS, type UiSymbols } from '../ui/symbols';
import type { ApprovalRequest } from './types';

export type AskModalProps = {
  questions: AskQuestion[];
  symbols: UiSymbols;
  onResolve: (answers: AskAnswer[] | 'fail') => void;
  onExit: () => void;
};

export function AskModal({ questions, symbols, onResolve, onExit }: AskModalProps): React.ReactElement {
  const [qIndex, setQIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [customMode, setCustomMode] = useState(false);
  const [custom, setCustom] = useState('');
  // answers 跨渲染持久化：setQIndex 触发重渲染时不清空已收集的答案
  const answersRef = useRef<AskAnswer[]>([]);
  const q = questions[qIndex];
  const options = q?.options ?? [];

  const commitAnswer = (ans: AskAnswer) => {
    answersRef.current.push(ans);
    if (qIndex + 1 < questions.length) {
      setQIndex(qIndex + 1);
      setCursor(0);
      setSelected(new Set());
      setCustomMode(false);
      setCustom('');
    } else {
      onResolve(answersRef.current);
    }
  };

  useInput((input, key) => {
    if (!q) {
      // questions 为空 / 异常数据：直接失败关闭 modal，而非退出整个应用
      onResolve('fail');
      return;
    }
    // Ctrl+C：中止整个问答（Ink 以 ctrl+c 输入派发，需显式拦截）
    if (key.ctrl && input === 'c') {
      onResolve('fail');
      return;
    }
    if (key.escape) {
      // customMode 且存在选项：Esc 先返回选项列表（与提示文案一致）
      if (customMode && options.length > 0) {
        setCustomMode(false);
        setCustom('');
        return;
      }
      onResolve('fail');
      return;
    }
    // 无选项的开放题自动进入自定义输入，无需按 c
    const inCustom = customMode || options.length === 0;
    if (inCustom) {
      if (key.return) {
        const ans: AskAnswer = { question: q.question, selectedLabels: [], customInput: custom.trim() || undefined };
        commitAnswer(ans);
        return;
      }
      if (key.backspace || key.delete) {
        setCustom((c) => c.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setCustom((c) => c + input);
      }
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + Math.max(options.length, 1)) % Math.max(options.length, 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % Math.max(options.length, 1));
      return;
    }
    if (input === 'c' || input === 'C') {
      setCustomMode(true);
      return;
    }
    if (key.return) {
      if (q.multiSelect) {
        const labels = [...selected].sort((a, b) => a - b).map((i) => options[i]?.label).filter(Boolean);
        commitAnswer({ question: q.question, selectedLabels: labels });
      } else {
        const opt = options[cursor];
        commitAnswer({ question: q.question, selectedLabels: opt ? [opt.label] : [] });
      }
      return;
    }
    if (q.multiSelect && input === ' ') {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      const i = digit - 1;
      if (q.multiSelect) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(i)) next.delete(i);
          else next.add(i);
          return next;
        });
        setCursor(i);
      } else {
        commitAnswer({ question: q.question, selectedLabels: [options[i].label] });
      }
    }
  });

  if (!q) return <Text></Text>;

  const inCustom = customMode || options.length === 0;
  const lines: React.ReactElement[] = [];
  lines.push(<Text key="header">? Agent 想确认（{qIndex + 1}/{questions.length}）</Text>);
  lines.push(<Text key="question">  {q.question}</Text>);
  if (!inCustom) {
    options.forEach((opt, i) => {
      const mark = q.multiSelect ? (selected.has(i) ? '[x]' : '[ ]') : '   ';
      const pointer = i === cursor ? `${symbols.pointer} ` : '  ';
      const desc = opt.description ? ` — ${opt.description}` : '';
      lines.push(<Text key={`opt-${i}`}>{pointer}{mark} {i + 1}) {opt.label}{desc}</Text>);
    });
    lines.push(
      <Text key="hint" dimColor>
        {q.multiSelect
          ? '  ↑↓ 选择  Space 勾选  Enter 提交  数字快捷  c 自定义  Esc 取消'
          : '  ↑↓ 选择  Enter 确认  数字快捷  c 自定义  Esc 取消'}
      </Text>,
    );
  } else {
    lines.push(<Text key="custom">  自定义: {custom}</Text>);
    lines.push(<Text key="customHint" dimColor>
      {options.length > 0 ? '  Enter 提交  Esc 返回选项 / 取消' : '  Enter 提交  Esc 取消'}
    </Text>);
  }
  return <>{lines}</>;
}

export type ApprovalModalProps = {
  request: ApprovalRequest;
  reason: string;
  symbols: UiSymbols;
  onResolve: (choice: 'allow' | 'deny' | 'always') => void;
  onExit: () => void;
};

export function ApprovalModal({ request, reason, symbols, onResolve, onExit }: ApprovalModalProps): React.ReactElement {
  useInput((input, key) => {
    // Ctrl+C 视为拒绝
    if (key.ctrl && input === 'c') {
      onResolve('deny');
      return;
    }
    if (key.escape) {
      onResolve('deny');
      return;
    }
    if (input === 'y' || input === 'Y') {
      onResolve('allow');
      return;
    }
    if (input === 'a' || input === 'A') {
      onResolve('always');
      return;
    }
    if (input === 'n' || input === 'N') {
      onResolve('deny');
    }
  });

  return (
    <>
      <Text color="yellow">{symbols.warn} 需要批准 · {request.toolName}</Text>
      <Text>  {request.description}</Text>
      {request.dangerReason ? <Text>  原因: {request.dangerReason}</Text> : reason ? <Text>  {reason}</Text> : null}
      {request.workspace ? <Text>  工作区: {request.workspace}</Text> : null}
      <Text dimColor>  [y] 允许这次  [n] 拒绝  [a] 本会话允许同类  Esc 拒绝</Text>
    </>
  );
}
