/**
 * Typed HTTP errors.
 *
 * Every error reaching the client carries a stable machine-readable `code` so
 * the web client can translate the message into Arabic or English itself
 * rather than displaying server-side English text.
 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (code = 'bad_request', message, details) =>
  new HttpError(400, code, message, details);
export const unauthorized = (code = 'unauthorized', message) => new HttpError(401, code, message);
export const forbidden = (code = 'forbidden', message) => new HttpError(403, code, message);
export const notFound = (code = 'not_found', message) => new HttpError(404, code, message);
export const conflict = (code = 'conflict', message) => new HttpError(409, code, message);
export const unprocessable = (code = 'unprocessable', message, details) =>
  new HttpError(422, code, message, details);
export const tooMany = (code = 'rate_limited', message) => new HttpError(429, code, message);

/** Map a database driver error onto something meaningful for the client. */
export function translateDbError(err) {
  const message = String(err?.message || '');
  const code = err?.code;
  // 23505 unique_violation (Postgres) / SQLITE_CONSTRAINT_UNIQUE
  if (code === '23505' || /UNIQUE constraint failed/i.test(message)) {
    return conflict('duplicate', 'A record with these details already exists.');
  }
  // 23503 foreign_key_violation
  if (code === '23503' || /FOREIGN KEY constraint failed/i.test(message)) {
    return badRequest('invalid_reference', 'A referenced record does not exist.');
  }
  // 23514 check_violation
  if (code === '23514' || /CHECK constraint failed/i.test(message)) {
    return badRequest('invalid_value', 'A value is outside the allowed set.');
  }
  return null;
}
