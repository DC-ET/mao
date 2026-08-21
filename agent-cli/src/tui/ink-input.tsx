import React, { useState, useCallback, useRef } from 'react';
import { useInput, useApp, Text, Box } from 'ink';
import { completeSlash } from '../ui/slash-complete';

const HISTORY_MAX = 50;

export interface InkInputProps {
  enabled: boolean;
  continuation: boolean;
  modelNames?: string[];
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExit: () => void;
  onDraftChange?: (draft: string) => void;
}

/**
 * Ink-based input controller. Replaces InputController + Composer for interactive mode.
 * Uses Ink's useInput hook to capture keystrokes and manage draft state.
 */
export function InkInput(props: InkInputProps): React.ReactElement {
  const { enabled, continuation, modelNames, onSubmit, onCancel, onExit, onDraftChange } = props;
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const [completionHint, setCompletionHint] = useState<string[]>([]);
  const bufferRef = useRef('');
  const { exit } = useApp();

  const setDraftSafe = useCallback((next: string) => {
    setDraft(next);
    onDraftChange?.(next);
  }, [onDraftChange]);

  const [cont, setCont] = useState(false);

  useInput((input, key) => {
    if (!enabled) return;

    // Ctrl+C
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    // Ctrl+D
    if (key.ctrl && input === 'd') {
      if (!draft && bufferRef.current === '') {
        onExit();
        exit();
      }
      return;
    }

    // Enter
    if (key.return) {
      const trimmed = draft.replace(/\s+$/, '');
      // Multi-line: backslash continuation
      if (trimmed.endsWith('\\') && !fenceOpen(bufferRef.current + trimmed.slice(0, -1))) {
        bufferRef.current += trimmed.slice(0, -1) + '\n';
        setDraftSafe('');
        setCont(true);
        return;
      }
      const combined = bufferRef.current + draft;
      // Multi-line: open code fence
      if (fenceOpen(combined)) {
        bufferRef.current = combined + '\n';
        setDraftSafe('');
        setCont(true);
        return;
      }
      bufferRef.current = '';
      setCont(false);
      const text = combined.trim();
      if (!text) return;
      // Save to history
      if (text) {
        setHistory((h) => {
          const next = [...h, text];
          if (next.length > HISTORY_MAX) next.shift();
          return next;
        });
      }
      setHistoryIdx(-1);
      setDraftSafe('');
      setCompletionHint([]);
      onSubmit(text);
      return;
    }

    // Up arrow: history
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIdx === -1) setHistoryDraft(draft);
      const nextIdx = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(nextIdx);
      setDraftSafe(history[history.length - 1 - nextIdx] ?? '');
      return;
    }

    // Down arrow: history
    if (key.downArrow) {
      if (historyIdx === -1) return;
      const nextIdx = historyIdx - 1;
      if (nextIdx < 0) {
        setHistoryIdx(-1);
        setDraftSafe(historyDraft);
      } else {
        setHistoryIdx(nextIdx);
        setDraftSafe(history[history.length - 1 - nextIdx] ?? '');
      }
      return;
    }

    // Tab: completion
    if (key.tab) {
      if (!draft.startsWith('/')) return;
      const [hits] = completeSlash(draft, { models: modelNames });
      if (hits.length === 1) {
        const inner = draft.slice(1);
        const space = inner.indexOf(' ');
        const completed = space === -1 ? hits[0] : `/${inner.slice(0, space + 1)}${hits[0]}`;
        setDraftSafe(completed);
      } else if (hits.length > 1) {
        setCompletionHint(hits);
      }
      return;
    }

    // Backspace/delete
    if (key.backspace || key.delete) {
      setDraftSafe(draft.slice(0, -1));
      setHistoryIdx(-1);
      setCompletionHint([]);
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
      setDraftSafe(draft + input);
      setHistoryIdx(-1);
      setCompletionHint([]);
    }
  }, { isActive: enabled });

  // 续行缓冲是否可见：显示已缓冲的续行内容（首行之后以「… 」前缀呈现）
  const buffered = bufferRef.current;
  const isCont = continuation || cont;
  return (
    <Box flexDirection="column">
      {completionHint.length > 0 && (
        <Text dimColor>{completionHint.join('  ')}</Text>
      )}
      {buffered ? (
        <Text dimColor>{buffered.split('\n').filter(Boolean).map((l) => `… ${l}`).join('\n')}</Text>
      ) : null}
      <Box>
        <Text color="cyan" bold>{isCont ? '… ' : '❯ '}</Text>
        <Text>{draft || (isCont ? '' : '继续对话，或输入 /help')}</Text>
      </Box>
    </Box>
  );
}

function fenceOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}
