/**
 * AppError maps to the wire error shape:
 *   { error: { code, message, reason?, details? } }
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly reason?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): { error: { code: string; message: string; reason?: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.reason !== undefined ? { reason: this.reason } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (what: string): AppError =>
  new AppError(404, 'NOT_FOUND', `${what} not found`);
