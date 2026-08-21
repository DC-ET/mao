import React, { useState, useCallback, useRef } from 'react';
import { useInput, useApp, Text, Box } from 'ink';
import { paletteWindow, slashPalette, type SlashPick } from '../ui/slash-complete';

const HISTORY_MAX = 50;
const PALETTE_MAX = 8;

export interface InkInputProps {
  enabled: boolean;
  continuation: boolean;
  asciiOnly?: boolean;
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
  const { enabled, continuation, asciiOnly, modelNames, onSubmit, onCancel, onExit, onDraftChange } = props;
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const [pickCursor, setPickCursor] = useState(0);
  const [paletteOff, setPaletteOff] = useState(false);
  const bufferRef = useRef('');
  const { exit } = useApp();

  const setDraftSafe = useCallback((next: string) => {
    setDraft(next);
    onDraftChange?.(next);
  }, [onDraftChange]);

  const [cont, setCont] = useState(false);
  const isCont = continuation || cont;
  const picks = !isCont && !paletteOff ? slashPalette(draft, { models: modelNames }) : [];
  const showPalette = picks.length > 0;
  const cursor = showPalette ? Math.min(pickCursor, picks.length - 1) : 0;

  const commitText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory((h) => {
      const next = [...h, trimmed];
      if (next.length > HISTORY_MAX) next.shift();
      return next;
    });
    setHistoryIdx(-1);
    setPickCursor(0);
    setPaletteOff(false);
    bufferRef.current = '';
    setCont(false);
    setDraftSafe('');
    onSubmit(trimmed);
  };

  const applyPick = (pick: SlashPick, submit: boolean) => {
    if (submit && pick.submit) {
      commitText(pick.value);
      return;
    }
    setDraftSafe(pick.value);
    setPickCursor(0);
    setPaletteOff(false);
  };

  useInput((input, key) => {
    if (!enabled) return;

    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    if (key.ctrl && input === 'd') {
      if (!draft && bufferRef.current === '') {
        onExit();
        exit();
      }
      return;
    }

    if (key.escape) {
      if (showPalette) {
        setPaletteOff(true);
        return;
      }
      return;
    }

    if (key.return) {
      if (showPalette) {
        const pick = picks[cursor];
        if (pick) applyPick(pick, true);
        return;
      }
      const trimmed = draft.replace(/\s+$/, '');
      if (trimmed.endsWith('\\') && !fenceOpen(bufferRef.current + trimmed.slice(0, -1))) {
        bufferRef.current += trimmed.slice(0, -1) + '\n';
        setDraftSafe('');
        setCont(true);
        return;
      }
      const combined = bufferRef.current + draft;
      if (fenceOpen(combined)) {
        bufferRef.current = combined + '\n';
        setDraftSafe('');
        setCont(true);
        return;
      }
      commitText(combined);
      return;
    }

    if (key.upArrow) {
      if (showPalette) {
        setPickCursor((c) => (c - 1 + picks.length) % picks.length);
        return;
      }
      if (history.length === 0) return;
      if (historyIdx === -1) setHistoryDraft(draft);
      const nextIdx = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(nextIdx);
      setDraftSafe(history[history.length - 1 - nextIdx] ?? '');
      return;
    }

    if (key.downArrow) {
      if (showPalette) {
        setPickCursor((c) => (c + 1) % picks.length);
        return;
      }
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

    if (key.tab) {
      if (showPalette) {
        const pick = picks[cursor];
        if (pick) applyPick(pick, false);
        return;
      }
      return;
    }

    if (key.backspace || key.delete) {
      setDraftSafe(draft.slice(0, -1));
      setHistoryIdx(-1);
      setPickCursor(0);
      setPaletteOff(false);
      return;
    }

    if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
      setDraftSafe(draft + input);
      setHistoryIdx(-1);
      setPickCursor(0);
      setPaletteOff(false);
    }
  }, { isActive: enabled });

  const buffered = bufferRef.current;
  const mark = isCont ? (asciiOnly ? '... ' : '… ') : (asciiOnly ? '> ' : '❯ ');
  const dots = asciiOnly ? '... ' : '… ';
  const pointer = asciiOnly ? '> ' : '❯ ';
  const { slice, offset } = paletteWindow(picks, cursor, PALETTE_MAX);

  return (
    <Box flexDirection="column">
      {showPalette ? (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={0}>
          {slice.map((pick, i) => {
            const idx = offset + i;
            const selected = idx === cursor;
            return (
              <Text key={`${pick.value}-${idx}`}>
                <Text color={selected ? 'cyan' : undefined} inverse={selected}>
                  {selected ? pointer : '  '}{pick.label}
                </Text>
                <Text dimColor>{`  ${pick.hint}`}</Text>
              </Text>
            );
          })}
          {picks.length > PALETTE_MAX ? (
            <Text dimColor>{`  … ${picks.length} 项`}</Text>
          ) : null}
          <Text dimColor>  ↑↓ 选择  Enter 确认  Tab 填入  Esc 关闭</Text>
        </Box>
      ) : null}
      {buffered ? (
        <Text dimColor>{buffered.split('\n').filter(Boolean).map((l) => `${dots}${l}`).join('\n')}</Text>
      ) : null}
      <Box borderStyle="round" borderColor={enabled ? 'cyan' : 'gray'} paddingX={1}>
        <Text color="cyan" bold>{mark}</Text>
        {draft ? <Text>{draft}</Text> : (isCont ? null : <Text dimColor>继续对话，或输入 /help</Text>)}
      </Box>
    </Box>
  );
}

function fenceOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}
