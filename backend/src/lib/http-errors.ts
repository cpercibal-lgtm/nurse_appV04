// Every error a client sees has the shape {error: {code, message, details?}}
// (docs/API.md). `code` is stable and machine-readable; `message` is safe
// to show a user and never contains SQL, constraint names or row data.

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (code = 'FORBIDDEN', message = 'You do not have permission to do this') => new HttpError(403, code, message);
export const notFound = (message = 'Record not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new HttpError(422, code, message, details);
