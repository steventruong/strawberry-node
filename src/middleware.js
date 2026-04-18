'use strict';

// Express / Connect compatible middleware. Records $http_request on every
// finished response and $http_error for 5xx / thrown errors. Stays best-effort
// — the surrounding request must never fail because of the SDK.

function createMiddleware(client) {
  return function strawberryMiddleware(req, res, next) {
    const start = Date.now();
    const method = req.method || 'GET';
    // Normalize path to route pattern when available (Express sets req.route
    // only after routing), otherwise fall back to req.url sans query string.
    const rawUrl = req.originalUrl || req.url || '/';
    const path = String(rawUrl).split('?')[0];

    let finished = false;
    const finalize = (extra) => {
      if (finished) return;
      finished = true;
      const durationMs = Date.now() - start;
      const status = res.statusCode || 0;
      const props = Object.assign(
        {
          $method: method,
          $path: path,
          $status: status,
          $duration_ms: durationMs,
          $user_agent: (req.headers && req.headers['user-agent']) || undefined,
        },
        extra || {},
      );
      try {
        if (status >= 500 || (extra && extra.$error_message)) {
          client.capture('$http_error', props);
        } else {
          client.capture('$http_request', props);
        }
      } catch (_) {
        // Swallow: middleware must not break the app.
      }
    };

    res.on('finish', () => finalize());
    res.on('close', () => finalize());

    // Wrap next() so thrown or passed errors get recorded.
    const wrappedNext = (err) => {
      if (err) {
        try {
          client.captureError(err, { path, method });
        } catch (_) {}
        finalize({ $error_message: (err && err.message) || String(err) });
      }
      if (typeof next === 'function') next(err);
    };

    try {
      if (typeof next === 'function') next();
      else wrappedNext();
    } catch (e) {
      wrappedNext(e);
    }
  };
}

module.exports = { createMiddleware };
