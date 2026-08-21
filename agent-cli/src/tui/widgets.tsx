import React from 'react';
import { Box, Text } from 'ink';
import { pickSymbols } from '../ui/symbols';
import { summarizeToolArgs } from '../ui/box';
import { truncate } from '../util/ansi';
import type { FooterMeta, TranscriptItem } from './types';
import { MarkdownBlock } from './markdown';

export function WelcomeCard({ lines }: { lines: string[] }): React.ReactElement {
  const [head, ...rest] = lines.length > 0 ? lines : ['mao-agent'];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
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

export function UserMessage({ text, ascii }: { text: string; ascii?: boolean }): React.ReactElement {
  const mark = ascii ? '>' : '❯';
  const rows = text.replace(/\s+$/, '').split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row, i) => (
        <Text key={i}>
          <Text color="cyan" bold>{i === 0 ? `${mark} ` : '  '}</Text>
          <Text>{row || ' '}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function ToolCallView(props: {
  name: string;
  args?: string;
  result?: string;
  running?: boolean;
  verbose?: boolean;
  ascii?: boolean;
}): React.ReactElement {
  const symbols = pickSymbols(Boolean(props.ascii));
  const rawArgs = summarizeToolArgs(props.args);
  const shown = props.verbose ? truncate(rawArgs, 200, 1) : truncate(rawArgs, 72, 1);
  let resultBody: string | undefined;
  if (!props.running) {
    const summary = props.result || 'ok';
    resultBody = props.verbose
      ? truncate(summary, 2000, 20)
      : truncate(summary.replace(/\s+/g, ' '), 100, 1);
  }
  const resultLines = resultBody ? resultBody.split('\n') : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">{symbols.tool} </Text>
        <Text color="cyan">{props.name}</Text>
        {shown ? <Text dimColor>{`  ${shown}`}</Text> : null}
      </Text>
      {resultLines.map((line, i) => (
        <Text key={i} dimColor>{`  ${symbols.toolTail}  ${line}`}</Text>
      ))}
    </Box>
  );
}

export function StatusLine({ text, tone }: { text: string; tone?: 'ok' | 'err' | 'warn' | 'dim' }): React.ReactElement {
  if (tone === 'err') return <Text color="red">{text}</Text>;
  if (tone === 'warn') return <Text color="yellow">{text}</Text>;
  if (tone === 'ok') return <Text color="green">{text}</Text>;
  return <Text dimColor>{text}</Text>;
}

export function FooterBar({ footer, running }: { footer: FooterMeta; running?: boolean }): React.ReactElement {
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
      {running ? <Text dimColor> · Ctrl+C 取消</Text> : null}
    </Box>
  );
}

export function TranscriptItemView({ item, ascii, verbose }: {
  item: TranscriptItem;
  ascii?: boolean;
  verbose?: boolean;
}): React.ReactElement | null {
  switch (item.kind) {
    case 'welcome':
      return <WelcomeCard lines={item.lines} />;
    case 'history':
      return item.lines.length > 0 ? <HistoryBlock lines={item.lines} /> : null;
    case 'user':
      return <UserMessage text={item.text} ascii={ascii} />;
    case 'assistant':
      return <MarkdownBlock text={item.text} />;
    case 'tool':
      return (
        <ToolCallView
          name={item.name}
          args={item.args}
          result={item.result}
          verbose={verbose}
          ascii={ascii}
        />
      );
    case 'status':
      return <StatusLine text={item.text} tone={item.tone} />;
    case 'sys':
      return <Text dimColor>{item.text || ' '}</Text>;
    default:
      return null;
  }
}
