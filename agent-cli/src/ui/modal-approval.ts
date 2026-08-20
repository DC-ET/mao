import type { ApprovalRequest } from '../local/approval';
import { UNICODE_SYMBOLS, type UiSymbols } from './symbols';
import type { InputController, ModalCtl } from './input-controller';
import type { ParsedKey } from './keys';

export type ApprovalChoice = 'allow' | 'deny' | 'always';

export async function askApprovalWithController(
  input: InputController,
  req: ApprovalRequest,
  reason: string,
  symbols: UiSymbols = UNICODE_SYMBOLS,
): Promise<ApprovalChoice> {
  return input.runModal((ctl) => runApproval(ctl, req, reason, symbols));
}

function runApproval(
  ctl: ModalCtl,
  req: ApprovalRequest,
  reason: string,
  symbols: UiSymbols,
): Promise<ApprovalChoice> {
  const lines = [
    `${symbols.warn} 需要批准 · ${req.toolName}`,
    `  ${req.description}`,
  ];
  if (req.dangerReason) lines.push(`  原因: ${req.dangerReason}`);
  else if (reason) lines.push(`  ${reason}`);
  if (req.workspace) lines.push(`  工作区: ${req.workspace}`);
  lines.push('  [y] 允许这次  [n] 拒绝  [a] 本会话允许同类  Esc 拒绝');

  return new Promise((resolve) => {
    ctl.write(`\n${lines.join('\n')}\n`);
    ctl.onKey((key: ParsedKey) => {
      if (key.name === 'char' && (key.char === 'y' || key.char === 'Y')) {
        ctl.write('\n');
        resolve('allow');
        return;
      }
      if (key.name === 'char' && (key.char === 'a' || key.char === 'A')) {
        ctl.write('\n');
        resolve('always');
        return;
      }
      if (
        key.name === 'esc' ||
        key.name === 'ctrl-c' ||
        (key.name === 'char' && (key.char === 'n' || key.char === 'N'))
      ) {
        ctl.write('\n');
        resolve('deny');
      }
    });
  });
}
