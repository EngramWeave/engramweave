import type { ErrorCode } from '@engramweave/contracts';

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status = 500) {
    super(message);
  }
}
export const errorCode = (error: unknown): ErrorCode => error instanceof CoreError ? error.code : 'IO_ERROR';
