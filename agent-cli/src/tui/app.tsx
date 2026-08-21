import React from 'react';
import { Text, Box, Static, render as inkRender } from 'ink';
import { pickSymbols } from '../ui/symbols';
import type { TuiAppProps } from './types';
import { InkInput } from './ink-input';
import { AskModal, ApprovalModal } from './modals';
import { FooterBar, ToolCallView, TranscriptItemView, UserMessage } from './widgets';
import { MarkdownBlock } from './markdown';

export function TuiApp(props: TuiAppProps): React.ReactElement {
  const {
    staticRounds,
    live,
    modal,
    continuation,
    footer,
    verboseTools,
    asciiOnly,
    onSubmit,
    onCancel,
    onExit,
    onAskResponse,
    onApprovalResponse,
  } = props;

  const symbols = pickSymbols(asciiOnly);

  return (
    <Box flexDirection="column">
      <Static items={staticRounds}>
        {(round) => (
          <Box flexDirection="column" key={round.id} marginBottom={1}>
            {round.items.map((item, i) => (
              <TranscriptItemView
                key={`${round.id}-${i}`}
                item={item}
                ascii={asciiOnly}
                verbose={verboseTools}
              />
            ))}
          </Box>
        )}
      </Static>

      {live.userText ? <UserMessage text={live.userText} ascii={asciiOnly} /> : null}

      {live.running ? (
        <Box flexDirection="column" marginTop={live.userText ? 0 : 1}>
          <Text color="cyan">
            {symbols.spin[live.spinnerFrame % symbols.spin.length]} {live.status || '思考中…'}
          </Text>
          {live.segmentRaw ? <MarkdownBlock text={live.segmentRaw} /> : null}
          {live.toolCalls.map((tc) => (
            <ToolCallView
              key={tc.toolCallId}
              name={tc.toolName}
              args={tc.arguments}
              result={tc.summary || tc.preview || tc.result}
              running={tc.status === 'RUNNING'}
              verbose={verboseTools}
              ascii={asciiOnly}
            />
          ))}
          {live.error ? <Text color="red">{symbols.err} {live.error}</Text> : null}
          {live.warnings.map((w, i) => (
            <Text key={`warn-${i}`} color="yellow">{w}</Text>
          ))}
        </Box>
      ) : null}

      {live.announce.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {live.announce.map((line, i) => (
            <Text key={`announce-${i}`} dimColor>{line || ' '}</Text>
          ))}
        </Box>
      ) : null}

      {modal?.type === 'ask' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
          <AskModal
            key={modal.requestId}
            questions={modal.questions}
            symbols={symbols}
            onResolve={(answers) => onAskResponse(modal.requestId, answers)}
            onExit={() => {}}
          />
        </Box>
      ) : null}
      {modal?.type === 'approval' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <ApprovalModal
            request={modal.request}
            reason={modal.reason}
            symbols={symbols}
            onResolve={onApprovalResponse}
            onExit={() => {}}
          />
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <InkInput
          enabled={!modal}
          continuation={continuation}
          asciiOnly={asciiOnly}
          modelNames={props.modelNames}
          onSubmit={onSubmit}
          onCancel={onCancel}
          onExit={onExit}
        />
        <FooterBar footer={footer} running={live.running} />
      </Box>
    </Box>
  );
}

export function createTuiApp(initialProps: TuiAppProps): { update: (patch: Partial<TuiAppProps>) => void; unmount: () => void } {
  let props = initialProps;
  const { rerender, unmount } = inkRender(React.createElement(TuiApp, props), { exitOnCtrlC: false });
  return {
    update(patch: Partial<TuiAppProps>) {
      props = { ...props, ...patch };
      rerender(React.createElement(TuiApp, props));
    },
    unmount() {
      unmount();
    },
  };
}
