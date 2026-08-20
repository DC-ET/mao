export interface UiSymbols {
  tool: string;
  toolTail: string;
  ok: string;
  err: string;
  warn: string;
  think: string;
  pointer: string;
  spin: string[];
}

export const UNICODE_SYMBOLS: UiSymbols = {
  tool: '⏺',
  toolTail: '⎿',
  ok: '✔',
  err: '✖',
  warn: '⚠',
  think: '…',
  pointer: '❯',
  spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export const ASCII_SYMBOLS: UiSymbols = {
  tool: '*',
  toolTail: '|',
  ok: '+',
  err: 'x',
  warn: '!',
  think: '...',
  pointer: '>',
  spin: ['|', '/', '-', '\\'],
};

export function pickSymbols(asciiOnly: boolean): UiSymbols {
  return asciiOnly ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}
