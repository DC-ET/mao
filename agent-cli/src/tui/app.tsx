import React from 'react';
import { Text, Box, Static, render as inkRender } from 'ink';
import { shouldUseColor, createAnsi, renderMarkdownLite, truncate, type Ansi } from '../util/ansi';
import { pickSymbols, type UiSymbols } from '../ui/symbols';
import { formatToolStart, formatToolResult, formatUserBlock, summarizeToolArgs } from '../ui/box';
import { formatTodoSummary } from '../ui/todo-summary';
import type { TuiAppProps } from './types';
import { InkInput } from './ink-input';
import { AskModal, ApprovalModal } from './modals';

export function TuiApp(props: TuiAppProps): React.ReactElement {
  const {
    staticRounds,
    live,
    modal,
    draft,
    continuation,
    meta,
    verboseTools,
    historyLines,
    welcomeLines,
    asciiOnly,
    onSubmit,
    onCancel,
    onExit,
    onAskResponse,
    onApprovalResponse,
    onSlashClear,
  } = props;

  const color = shouldUseColor({ colorFlag: undefined, printMode: false, stdoutIsTty: true });
  const ansi = createAnsi(color);
  const symbols = pickSymbols(asciiOnly);

  return (
    <Box flexDirection="column">
      {/* Static rounds written to scrollback */}
      {staticRounds.length > 0 && (
        <Static items={staticRounds}>
          {(round) => (
            <Box flexDirection="column" key={round.id}>
              {round.lines.map((line, i) => (
                <Text key={`${round.id}-${i}`}>{line}</Text>
              ))}
            </Box>
          )}
        </Static>
      )}

      {/* Welcome + history lines (only before first round) */}
      {staticRounds.length === 0 && (
        <Box flexDirection="column">
          {welcomeLines.map((line, i) => (
            <Text key={`welcome-${i}`} dimColor>{line}</Text>
          ))}
          {historyLines.map((line, i) => (
            <Text key={`history-${i}`}>{line}</Text>
          ))}
        </Box>
      )}

      {/* Live (in-progress) content */}
      {live.running && (
        <Box flexDirection="column">
          <Text dimColor>
            {symbols.spin[live.spinnerFrame % symbols.spin.length]} {live.status}
          </Text>
          {live.segmentRaw ? (
            <Text>{ansi.enabled ? renderMarkdownLite(live.segmentRaw, ansi) : live.segmentRaw}</Text>
          ) : null}
          {live.toolCalls.map((tc) => {
            const args = summarizeToolArgs(tc.arguments);
            const shown = verboseTools ? truncate(args, 200, 1) : truncate(args, 72, 1);
            const startLine = formatToolStart(tc.toolName, shown, { ascii: asciiOnly, paint: (s) => ansi.cyan(s) });
            const summary = tc.summary || tc.preview || '';
            let resultLine = '';
            if (tc.status !== 'RUNNING') {
              if (verboseTools) {
                const extra = summary ? truncate(summary, 2000, 20) : (tc.status || 'ok');
                resultLine = extra.split('\n').map((l: string) => ansi.dim(`    ${symbols.toolTail}  ${l}`)).join('\n');
              } else {
                const extra = summary ? truncate(summary.replace(/\s+/g, ' '), 100, 1) : (tc.status || 'ok');
                resultLine = formatToolResult(extra, { ascii: asciiOnly, paint: (s) => ansi.dim(s) });
              }
            }
            return (
              <Box flexDirection="column" key={tc.toolCallId}>
                <Text>{startLine}</Text>
                {resultLine ? <Text>{resultLine}</Text> : null}
              </Box>
            );
          })}
          {live.error ? <Text color="red">{symbols.err} {live.error}</Text> : null}
          {live.warnings.map((w, i) => (
            <Text key={`warn-${i}`} color="yellow">{w}</Text>
          ))}
        </Box>
      )}

      {/* Live announce messages (always visible, above input) */}
      {live.announce.length > 0 && (
        <Box flexDirection="column">
          {live.announce.map((line, i) => (
            <Text key={`announce-${i}`}>{line}</Text>
          ))}
        </Box>
      )}

      {/* Modal overlays */}
      {modal?.type === 'ask' && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <AskModal
            key={modal.requestId}
            questions={modal.questions}
            symbols={symbols}
            onResolve={(answers) => onAskResponse(modal.requestId, answers)}
            onExit={() => {}}
          />
        </Box>
      )}
      {modal?.type === 'approval' && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <ApprovalModal
            request={modal.request}
            reason={modal.reason}
            symbols={symbols}
            onResolve={onApprovalResponse}
            onExit={() => {}}
          />
        </Box>
      )}

      {/* Footer: input + meta */}
      <Box flexDirection="column" marginTop={1}>
        <InkInput
          enabled={!modal}
          continuation={continuation}
          modelNames={props.modelNames}
          onSubmit={onSubmit}
          onCancel={onCancel}
          onExit={onExit}
        />
        <Text dimColor> {meta}</Text>
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
