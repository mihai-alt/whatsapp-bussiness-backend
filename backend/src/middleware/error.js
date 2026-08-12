export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extras = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (extras && typeof extras === 'object') {
      if (extras.state) this.state = extras.state;
      if (extras.details !== undefined) this.details = extras.details;
    }
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(err, req, res, next) {
  if (err?.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      state: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors,
      },
    });
  }

  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error',
    state: err.state || (status === 409 ? 'already_connected' : 'failed'),
    error: {
      code,
      message: err.message || 'Internal server error',
      details: err.details || undefined,
    },
  });
}
