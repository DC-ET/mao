import React from 'react';
import { Box, Text } from 'ink';
import type { InputRow, InputView } from './input-controller';
import { borderStyleFor } from './widgets';

function CursorRow({ row, ascii }: { row: InputRow; ascii: boolean }): React.ReactElement {
  const at = row.cursorAt;
  const left = row.clipLeft ? (ascii ? '<' : '‹') : '';
  const right = row.clipRight ? (ascii ? '>' : '›') : '';
  if (at === undefined) {
    return (
      <Text>
        {left ? <Text dimColor>{left}</Text> : null}
        <Text>{row.text || ' '}</Text>
        {right ? <Text dimColor>{right}</Text> : null}
      </Text>
    );
  }
  const before = row.text.slice(0, at);
  const under = row.text.slice(at, at + 1) || ' ';
  const after = row.text.slice(at + 1);
  return (
    <Text>
      {left ? <Text dimColor>{left}</Text> : null}
      <Text>{before}</Text>
      <Text inverse>{under}</Text>
      <Text>{after}</Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Text>
  );
}

export function InputBox({ view, ascii, enabled }: {
  view: InputView;
  ascii: boolean;
  enabled: boolean;
}): React.ReactElement {
  const pointer = ascii ? '> ' : '❯ ';
  const contMark = ascii ? '. ' : '· ';
  const palette = view.palette;
  return (
    <Box flexDirection="column">
      {palette ? (
        <Box flexDirection="column" borderStyle={borderStyleFor(ascii)} borderColor="gray" paddingX={1}>
          {palette.items.map((pick, i) => {
            const selected = i === palette.cursor;
            return (
              <Text key={`${pick.value}-${i}`}>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {selected ? pointer : '  '}{pick.label}
                </Text>
                <Text dimColor>{`  ${pick.hint}`}</Text>
              </Text>
            );
          })}
          {palette.total > palette.items.length ? (
            <Text dimColor>{`  … 共 ${palette.total} 项`}</Text>
          ) : null}
          <Text dimColor>{ascii ? '  Up/Down 选择  Enter 确认  Tab 填入  Esc 关闭' : '  ↑↓ 选择  Enter 确认  Tab 填入  Esc 关闭'}</Text>
        </Box>
      ) : null}
      <Box borderStyle={borderStyleFor(ascii)} borderColor={enabled ? 'cyan' : 'gray'} paddingX={1}>
        <Box flexDirection="column" width={2} flexShrink={0}>
          {view.rows.map((_, i) => (
            <Text key={i} color="cyan" bold>{i === 0 ? pointer : contMark}</Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {view.placeholder ? (
            <Text dimColor>{enabled ? '继续对话，或输入 / 查看命令' : '等待上方确认…'}</Text>
          ) : (
            view.rows.map((row, i) => <CursorRow key={i} row={row} ascii={ascii} />)
          )}
        </Box>
      </Box>
    </Box>
  );
}
