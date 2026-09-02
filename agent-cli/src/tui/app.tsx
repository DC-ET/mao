import React from 'react';
import { Box, Static, Text, render as inkRender } from 'ink';
import type { TuiAppProps } from './types';
import { InputBox } from './input-box';
import { FooterBar, PanelLines, TranscriptItemView, borderStyleFor } from './widgets';
import { MdLineView } from './markdown';

/**
 * 渲染树只有两层：<Static> 承载已定稿内容（写一次不再重绘），
 * 其余 live 区高度由 renderer 预先裁剪过，恒小于终端行数，
 * 因此不会触发 Ink 的 clearTerminal 全屏重绘分支。
 */
export function TuiApp(props: TuiAppProps): React.ReactElement {
  const { staticBlocks, live, input, panel, footer, asciiOnly, columns } = props;

  return (
    <Box flexDirection="column">
      <Static items={staticBlocks}>
        {(block) => (
          <Box flexDirection="column" key={block.id} marginBottom={block.spaced ? 1 : 0}>
            {block.items.map((item, i) => (
              <TranscriptItemView
                key={`${block.id}-${i}`}
                item={item}
                ascii={asciiOnly}
                verbose={props.verboseTools}
                columns={columns}
              />
            ))}
          </Box>
        )}
      </Static>

      {live.thinking.map((line, i) => (
        <Text key={`think-${i}`} dimColor italic>{line || ' '}</Text>
      ))}

      {live.tail.map((line, i) => (
        <MdLineView key={`tail-${i}`} line={line} />
      ))}

      {live.tools.map((t) => (
        <Text key={t.id} color="cyan">{t.text}</Text>
      ))}

      {live.status ? <Text color="cyan">{live.status}</Text> : null}

      {live.announce.map((line, i) => (
        <Text key={`ann-${i}`} dimColor>{line || ' '}</Text>
      ))}

      {panel ? (
        <Box flexDirection="column" borderStyle={borderStyleFor(asciiOnly)} borderColor={panel.borderColor} paddingX={1}>
          <PanelLines lines={panel.lines} />
        </Box>
      ) : null}

      {input ? <InputBox view={input} ascii={asciiOnly} enabled={!panel} /> : null}
      <FooterBar footer={footer} hint={live.status ? 'Ctrl+C 取消' : undefined} />
    </Box>
  );
}

export interface TuiMount {
  update: (props: TuiAppProps) => void;
  unmount: () => void;
  /** 把实例从 Ink 的 stdout→instance 缓存里摘掉，下一次 render 才会真正新建。 */
  cleanup: () => void;
}

export interface TuiMountOptions {
  /** 必须与 renderer 计算布局预算时用的同一个流：Ink 用它的 rows/columns 判断是否整屏重绘。 */
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

export function createTuiApp(initialProps: TuiAppProps, opts: TuiMountOptions): TuiMount {
  const { rerender, unmount, cleanup } = inkRender(React.createElement(TuiApp, initialProps), {
    stdout: opts.stdout,
    stdin: opts.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    update(next: TuiAppProps) {
      rerender(React.createElement(TuiApp, next));
    },
    unmount() {
      unmount();
      cleanup();
    },
    cleanup,
  };
}
