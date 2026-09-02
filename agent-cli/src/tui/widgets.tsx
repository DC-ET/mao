import React from 'react';
import { Box, Text } from 'ink';
import { pickSymbols } from '../ui/symbols';
import { summarizeToolArgs, truncate } from '../ui/tool-format';
import type { FooterMeta, PanelLine, TranscriptItem, Tone } from './types';
import { MdLineView } from './markdown';

/** ascii 模式用 cli-boxes 的 classic 样式（+ - |），避免宽字符边框错位。 */
export function borderStyleFor(ascii: boolean): 'round' | 'classic' {
  return ascii ? 'classic' : 'round';
}

function toneColor(tone?: Tone): { color?: string; dimColor?: boolean } {
  if (tone === 'err') return { color: 'red' };
  if (tone === 'warn') return { color: 'yellow' };
  if (tone === 'ok') return { color: 'green' };
  if (tone === 'info') return { color: 'cyan' };
  return { dimColor: true };
}

export function ToneText({ text, tone, bold }: { text: string; tone?: Tone; bold?: boolean }): React.ReactElement {
  const props = toneColor(tone);
  return <Text {...props} bold={bold}>{text || ' '}</Text>;
}

export function WelcomeCard({ lines, ascii }: { lines: string[]; ascii: boolean }): React.ReactElement {
  const [head, ...rest] = lines.length > 0 ? lines : ['mao-agent'];
  return (
    <Box flexDirection="column" borderStyle={borderStyleFor(ascii)} borderColor="gray" paddingX={1}>
      <Text bold color="cyan">{head}</Text>
      {rest.map((line, i) => (
        <Text key={i} dimColor>{line || ' '}</Text>
      ))}
    </Box>
  );
}

export function HistoryBlock({ lines }: { lines: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>── 最近对话 ──</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>{line || ' '}</Text>
      ))}
    </Box>
  );
}

export function UserMessage({ text, ascii }: { text: string; ascii: boolean }): React.ReactElement {
  const mark = ascii ? '>' : '❯';
  const rows = text.replace(/\s+$/, '').split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row, i) => (
        <Text key={i}>
          <Text color="cyan" bold>{i === 0 ? `${mark} ` : '  '}</Text>
          <Text bold>{row || ' '}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function ToolCallView(props: {
  name: string;
  args?: string;
  result?: string;
  failed?: boolean;
  verbose?: boolean;
  ascii?: boolean;
}): React.ReactElement {
  const symbols = pickSymbols(Boolean(props.ascii));
  const rawArgs = summarizeToolArgs(props.args);
  const shown = props.verbose ? truncate(rawArgs, 200, 1) : truncate(rawArgs, 72, 1);
  const summary = props.result ?? '';
  const resultBody = props.verbose
    ? truncate(summary, 2000, 20)
    : truncate(summary.replace(/\s+/g, ' '), 100, 1);
  const resultLines = resultBody ? resultBody.split('\n') : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={props.failed ? 'red' : 'cyan'}>{symbols.tool} </Text>
        <Text color={props.failed ? 'red' : 'cyan'}>{props.name}</Text>
        {shown ? <Text dimColor>{`  ${shown}`}</Text> : null}
      </Text>
      {resultLines.map((line, i) => (
        <Text key={i} dimColor>{`  ${symbols.toolTail}  ${line}`}</Text>
      ))}
    </Box>
  );
}

export function Divider({ columns, ascii }: { columns: number; ascii: boolean }): React.ReactElement {
  const bar = (ascii ? '-' : '─').repeat(Math.max(4, Math.min(columns, 120)));
  return <Text dimColor>{bar}</Text>;
}

export function FooterBar({ footer, hint }: { footer: FooterMeta; hint?: string }): React.ReactElement {
  const modeColor = footer.executionMode === 'LOCAL' ? 'yellow' : 'blue';
  return (
    <Box>
      <Text dimColor>{footer.agentName}</Text>
      <Text dimColor> · </Text>
      <Text color="cyan">{footer.modelName}</Text>
      <Text dimColor> · </Text>
      <Text color={modeColor}>{footer.executionMode}</Text>
      {footer.contextPct ? <Text dimColor>{` · ${footer.contextPct}`}</Text> : null}
      {footer.todo ? <Text dimColor>{` · ${footer.todo}`}</Text> : null}
      {hint ? <Text dimColor>{` · ${hint}`}</Text> : null}
    </Box>
  );
}

export function PanelLines({ lines }: { lines: PanelLine[] }): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => (
        <Text
          key={i}
          {...toneColor(line.tone)}
          bold={line.bold}
          inverse={line.active}
        >
          {line.text || ' '}
        </Text>
      ))}
    </>
  );
}

export function TranscriptItemView({ item, ascii, verbose, columns }: {
  item: TranscriptItem;
  ascii: boolean;
  verbose: boolean;
  columns: number;
}): React.ReactElement | null {
  switch (item.kind) {
    case 'welcome':
      return <WelcomeCard lines={item.lines} ascii={ascii} />;
    case 'history':
      return item.lines.length > 0 ? <HistoryBlock lines={item.lines} /> : null;
    case 'user':
      return <UserMessage text={item.text} ascii={ascii} />;
    case 'mdline':
      return <MdLineView line={item.line} />;
    case 'thinking':
      return <Text dimColor italic>{item.text || ' '}</Text>;
    case 'tool':
      return (
        <ToolCallView
          name={item.name}
          args={item.args}
          result={item.result}
          failed={item.failed}
          verbose={verbose}
          ascii={ascii}
        />
      );
    case 'status':
      return <ToneText text={item.text} tone={item.tone} />;
    case 'sys':
      return <ToneText text={item.text} tone={item.tone} />;
    case 'divider':
      return <Divider columns={columns} ascii={ascii} />;
    default:
      return null;
  }
}
