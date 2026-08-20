export interface UiSymbols {
  tool: string;
  ok: string;
  err: string;
  warn: string;
  think: string;
  pointer: string;
  spin: string[];
}

export const UNICODE_SYMBOLS: UiSymbols = {
  tool: '▸',
  ok: '✔',
  err: '✖',
  warn: '⚠',
  think: '…',
  pointer: '❯',
  spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export const ASCII_SYMBOLS: UiSymbols = {
  tool: '>',
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
