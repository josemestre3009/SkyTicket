export class AuthError extends Error {
  constructor(message, { statusCode = 400, code = 'auth_error', details } = {}) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class UnauthorizedError extends AuthError {
  constructor(message = 'Authentication required', code = 'unauthorized') {
    super(message, { statusCode: 401, code });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = 'Access denied', code = 'forbidden') {
    super(message, { statusCode: 403, code });
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AuthError {
  constructor(message = 'Conflict', code = 'conflict') {
    super(message, { statusCode: 409, code });
    this.name = 'ConflictError';
  }
}

export class TooManyRequestsError extends AuthError {
  constructor(message = 'Too many requests', retryAfterSec = 1, code = 'rate_limited') {
    super(message, { statusCode: 429, code });
    this.name = 'TooManyRequestsError';
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterSec));
  }
}
