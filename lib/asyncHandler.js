'use strict';

/**
 * Wrap an async Express handler so a rejected promise is forwarded to the
 * error-handling middleware instead of crashing the process or hanging the
 * request. Lets route handlers be written as straight-line async code without
 * a try/catch in every one.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Terminal error-handling middleware. Pterodactyl client/app errors carry their
 * upstream HTTP status in the message (e.g. "...API 429: ..."); surface that
 * status so the frontend can react (rate limits, not-found, etc.). Everything
 * else is treated as a 500 and logged.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const match = /Pterodactyl (?:App|Client) API (\d+):/.exec(err.message || '');
  const status = match ? parseInt(match[1], 10) : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = { asyncHandler, errorHandler };
