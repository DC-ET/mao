import React from 'react';
import { Text } from 'ink';
import { splitInline, type InlinePart, type MdLine } from './markdown-parse';

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

/** 单行 Markdown 渲染。行分类在流式阶段完成，这里只上色。 */
export function MdLineView({ line }: { line: MdLine }): React.ReactElement {
  if (line.kind === 'empty') return <Text> </Text>;
  if (line.kind === 'fence') return <Text dimColor>{line.text || ' '}</Text>;
  if (line.kind === 'code') return <Text color="gray">{line.text || ' '}</Text>;
  if (line.kind === 'heading') {
    const color = (line.level ?? 3) <= 2 ? 'cyan' : 'white';
    return <Text bold color={color}>{line.text || ' '}</Text>;
  }
  if (line.kind === 'table') return <Text dimColor>{line.text}</Text>;
  if (line.kind === 'list') {
    const m = line.text.match(/^(\s*(?:[-*]|\d+[.)])\s+)(.*)$/);
    if (!m) return <Inline parts={splitInline(line.text)} />;
    return (
      <Text>
        <Text color="cyan">{m[1]}</Text>
        <Inline parts={splitInline(m[2])} />
      </Text>
    );
  }
  return <Inline parts={splitInline(line.text)} />;
}
