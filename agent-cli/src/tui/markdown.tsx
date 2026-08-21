import React from 'react';
import { Box, Text } from 'ink';
import { consumeMarkdownLines, splitInline, type InlinePart, type MdLine } from './markdown-parse';

function Inline({ parts }: { parts: InlinePart[] }): React.ReactElement {
  return (
    <Text>
      {parts.map((part, i) => {
        if (part.style === 'bold') return <Text key={i} bold>{part.text}</Text>;
        if (part.style === 'code') return <Text key={i} color="cyan">{part.text}</Text>;
        return <Text key={i}>{part.text}</Text>;
      })}
    </Text>
  );
}

function MarkdownLineView({ line }: { line: MdLine }): React.ReactElement {
  if (line.kind === 'empty') return <Text> </Text>;
  if (line.kind === 'fence') return <Text dimColor>{line.text || ' '}</Text>;
  if (line.kind === 'code') return <Text>{line.text || ' '}</Text>;
  if (line.kind === 'heading') {
    const color = (line.level ?? 3) <= 2 ? 'cyan' : 'white';
    return <Text bold color={color}>{line.text || ' '}</Text>;
  }
  if (line.kind === 'table') return <Text dimColor>{line.text}</Text>;
  if (line.kind === 'list') {
    const m = line.text.match(/^(\s*[-*]\s+)(.*)$/);
    if (!m) return <Inline parts={splitInline(line.text)} />;
    return (
      <Text>
        <Text dimColor>{m[1]}</Text>
        <Inline parts={splitInline(m[2])} />
      </Text>
    );
  }
  return <Inline parts={splitInline(line.text)} />;
}

export function MarkdownBlock({ text }: { text: string }): React.ReactElement {
  const lines = consumeMarkdownLines(text);
  if (lines.length === 0) return <Text> </Text>;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <MarkdownLineView key={i} line={line} />
      ))}
    </Box>
  );
}
