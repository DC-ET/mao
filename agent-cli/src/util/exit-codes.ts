/** 对齐设计文档 §11.2，写成常量供单测固化。 */
export const EXIT = {
  SUCCESS: 0,
  GENERAL: 1,
  FAILED: 2,
  CANCELLED: 3,
  APPROVAL: 4,
  QUESTION: 5,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.GENERAL) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
