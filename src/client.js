'use strict';

const { CHANNEL, ENDPOINT, DEFAULTS } = require('./types');
const { BufferRegistry } = require('./buffers');
const { Transport } = require('./transport');
const { createRedactor } = require('./redact');
const { createMiddleware } = require('./middleware');

// The Client holds per-channel buffers, a background flush loop, and a
// transport. Public methods never throw — observability must not break the
// caller. When uninitialized, capture/log/identify/etc become no-ops.
class Client {
  constructor(apiKey, opts) {
    opts = opts || {};
    this.apiKey = apiKey;
    this.host = opts.host || DEFAULTS.HOST;
    this.releaseVersion = opts.releaseVersion || process.env.STRAWBERRY_RELEASE || '';
    this.environment =
      opts.environment ||
      process.env.STRAWBERRY_ENV ||
      process.env.NODE_ENV ||
      'production';
    this.batchSize = opts.batchSize || DEFAULTS.BATCH_SIZE;
    this.flushIntervalMs = opts.flushInterval || DEFAULTS.FLUSH_INTERVAL_MS;
    this.dryRun = !!opts.dryRun;

    this._clock = opts.clock || { now: () => Date.now(), setTimeout, clearTimeout };
    this._buffers = new BufferRegistry(DEFAULTS.CHANNEL_CAPACITY);
    this._redactor = opts.redactor || createRedactor();
    this._transport = new Transport({
      host: this.host,
      apiKey: this.apiKey,
      transport: opts.transport,
      clock: this._clock,
      dryRun: this.dryRun,
    });

    this._enabled = !!apiKey;
    this._shutdown = false;
    this._flushing = false;
    this._timer = null;
    this._exitHook = null;

    if (this._enabled) this._scheduleFlush();
    this._installExitHook();
  }

  isEnabled() {
    return this._enabled && !this._shutdown;
  }

  _scheduleFlush() {
    if (this._shutdown) return;
    const setT = (this._clock && this._clock.setTimeout) || setTimeout;
    this._timer = setT(() => {
      this.flush().catch(() => {}).then(() => this._scheduleFlush());
    }, this.flushIntervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _clearTimer() {
    if (!this._timer) return;
    const clearT = (this._clock && this._clock.clearTimeout) || clearTimeout;
    clearT(this._timer);
    this._timer = null;
  }

  _installExitHook() {
    if (typeof process === 'undefined' || !process.on) return;
    const hook = () => {
      // Best-effort synchronous flush trigger — Node allows microtasks during
      // 'exit' but not IO, so this is mostly a last-ditch shutdown signal.
      this._shutdown = true;
      this._clearTimer();
    };
    this._exitHook = hook;
    try {
      process.on('exit', hook);
    } catch (_) {}
  }

  _uninstallExitHook() {
    if (this._exitHook && typeof process !== 'undefined' && process.removeListener) {
      try {
        process.removeListener('exit', this._exitHook);
      } catch (_) {}
    }
    this._exitHook = null;
  }

  // ------- public API -------

  capture(event, props, distinctId) {
    if (!this.isEnabled()) return;
    try {
      const safe = this._redactor.redact(props || {});
      this._buffers.get(CHANNEL.EVENTS).push({
        event_type: String(event || ''),
        properties: Object.assign({}, safe, {
          $environment: this.environment,
          $release_version: this.releaseVersion || undefined,
        }),
        timestamp: new Date().toISOString(),
        distinct_id: distinctId || (props && props.distinct_id) || undefined,
      });
      this._maybeFlushNow(CHANNEL.EVENTS);
    } catch (_) {}
  }

  identify(distinctId, props) {
    if (!this.isEnabled()) return;
    try {
      const safe = this._redactor.redact(props || {});
      // Identify rides on the same events channel as a $identify event — the
      // backend treats it as a person-upsert signal.
      this._buffers.get(CHANNEL.EVENTS).push({
        event_type: '$identify',
        properties: Object.assign({}, safe, { $environment: this.environment }),
        timestamp: new Date().toISOString(),
        distinct_id: String(distinctId || ''),
      });
      this._maybeFlushNow(CHANNEL.EVENTS);
    } catch (_) {}
  }

  captureError(err, context) {
    if (!this.isEnabled()) return;
    try {
      const isErr = err && typeof err === 'object' && (err.stack || err.message);
      const errorType = isErr ? err.name || 'Error' : 'Error';
      const message = isErr ? err.message || String(err) : String(err);
      const stack = isErr ? err.stack || '' : '';
      const safeCtx = this._redactor.redact(context || {});
      this._buffers.get(CHANNEL.ERRORS).push({
        error_type: errorType,
        message: this._redactor.redact(message),
        stack_trace: this._redactor.redact(stack),
        context: safeCtx,
        tags: { environment: this.environment },
        release_version: this.releaseVersion || undefined,
        source_map_id: (context && context.source_map_id) || undefined,
      });
      this._maybeFlushNow(CHANNEL.ERRORS);
    } catch (_) {}
  }

  log(level, message, category, attrs) {
    if (!this.isEnabled()) return;
    try {
      const lvl = String(level || 'info').toLowerCase();
      const normalized = DEFAULTS.VALID_LOG_LEVELS.indexOf(lvl) !== -1 ? lvl : 'info';
      const safe = this._redactor.redact(attrs || {});
      this._buffers.get(CHANNEL.LOGS).push({
        level: normalized,
        message: this._redactor.redact(String(message || '')),
        service: category || undefined,
        context: safe,
        timestamp: new Date().toISOString(),
      });
      this._maybeFlushNow(CHANNEL.LOGS);
    } catch (_) {}
  }

  llmCall(params) {
    if (!this.isEnabled()) return;
    try {
      params = params || {};
      const props = {
        $provider: params.provider,
        $model: params.model,
        $prompt_tokens: params.promptTokens || 0,
        $completion_tokens: params.completionTokens || 0,
        $latency_ms: params.latencyMs,
        $cost_usd: params.costUsd,
        $status: params.status || 'success',
        $streaming: !!params.streaming,
        $error_message: params.errorMessage,
        $environment: this.environment,
      };
      // LLM calls ride on the events channel as "$llm_call" — this matches
      // how the backend indexes them for the LLM observability view.
      this._buffers.get(CHANNEL.LLM).push({
        event_type: '$llm_call',
        properties: this._redactor.redact(props),
        timestamp: new Date().toISOString(),
        distinct_id: params.distinctId || undefined,
      });
      this._maybeFlushNow(CHANNEL.LLM);
    } catch (_) {}
  }

  middleware() {
    return createMiddleware(this);
  }

  async flush() {
    if (!this._enabled) return;
    if (this._flushing) return; // coalesce concurrent flushes
    this._flushing = true;
    try {
      await this._flushEvents();
      await this._flushErrors();
      await this._flushLogs();
    } finally {
      this._flushing = false;
    }
  }

  async shutdown() {
    this._shutdown = true;
    this._clearTimer();
    const timeoutMs = DEFAULTS.SHUTDOWN_TIMEOUT_MS;
    await Promise.race([
      this.flush().catch(() => {}),
      new Promise((resolve) => {
        const setT = (this._clock && this._clock.setTimeout) || setTimeout;
        setT(resolve, timeoutMs);
      }),
    ]);
    this._enabled = false;
    this._uninstallExitHook();
  }

  diagnostics() {
    return {
      enabled: this.isEnabled(),
      host: this.host,
      environment: this.environment,
      release_version: this.releaseVersion,
      buffers: this._buffers.snapshots(),
      transport: this._transport.snapshot(),
      redactions: this._redactor.stats(),
      dry_run: this.dryRun,
    };
  }

  // ------- internal flush helpers -------

  _maybeFlushNow(channel) {
    const buf = this._buffers.get(channel);
    if (buf.size >= this.batchSize) {
      // Fire-and-forget; errors already suppressed inside flush.
      this.flush().catch(() => {});
    }
  }

  async _flushChannel(channel, endpoint, wrap) {
    const buf = this._buffers.get(channel);
    while (buf.size > 0) {
      const batch = buf.drain(this.batchSize);
      if (batch.length === 0) break;
      const payload = wrap(batch);
      const res = await this._transport.send(endpoint, payload);
      if (!res.ok) {
        // Preserve order: put items back at head. Drop-newest kicks in if
        // the channel has been filling in parallel.
        buf.requeueFront(batch);
        // Stop draining this channel for this flush cycle — next timer tick
        // or next call will try again after backoff.
        return;
      }
    }
  }

  async _flushEvents() {
    // Events + LLM share the same /ingest endpoint.
    await this._flushChannel(CHANNEL.EVENTS, ENDPOINT.INGEST, (batch) => ({
      api_key: this.apiKey,
      events: batch,
    }));
    await this._flushChannel(CHANNEL.LLM, ENDPOINT.INGEST, (batch) => ({
      api_key: this.apiKey,
      events: batch,
    }));
  }

  async _flushErrors() {
    const buf = this._buffers.get(CHANNEL.ERRORS);
    while (buf.size > 0) {
      // Errors endpoint accepts one payload per call; send them individually.
      const batch = buf.drain(1);
      if (batch.length === 0) break;
      const item = batch[0];
      const payload = Object.assign({}, item, { api_key: this.apiKey });
      const res = await this._transport.send(ENDPOINT.ERRORS, payload);
      if (!res.ok) {
        buf.requeueFront(batch);
        return;
      }
    }
  }

  async _flushLogs() {
    const buf = this._buffers.get(CHANNEL.LOGS);
    while (buf.size > 0) {
      const batch = buf.drain(1);
      if (batch.length === 0) break;
      const item = batch[0];
      const payload = Object.assign({}, item, { api_key: this.apiKey });
      const res = await this._transport.send(ENDPOINT.LOGS, payload);
      if (!res.ok) {
        buf.requeueFront(batch);
        return;
      }
    }
  }
}

// Module-level singleton for the convenience functional API.
let _default = null;

function init(apiKey, opts) {
  if (_default) {
    // Re-init replaces the previous client. Best-effort shutdown; don't await.
    _default.shutdown().catch(() => {});
  }
  _default = new Client(apiKey, opts);
  return _default;
}

function _def() {
  return _default;
}

function capture(event, props, distinctId) {
  const c = _def();
  if (c) c.capture(event, props, distinctId);
}
function identify(distinctId, props) {
  const c = _def();
  if (c) c.identify(distinctId, props);
}
function captureError(err, context) {
  const c = _def();
  if (c) c.captureError(err, context);
}
function log(level, message, category, attrs) {
  const c = _def();
  if (c) c.log(level, message, category, attrs);
}
function llmCall(params) {
  const c = _def();
  if (c) c.llmCall(params);
}
async function flush() {
  const c = _def();
  if (c) await c.flush();
}
async function shutdown() {
  const c = _def();
  if (c) await c.shutdown();
  _default = null;
}
function isEnabled() {
  const c = _def();
  return !!(c && c.isEnabled());
}
function diagnostics() {
  const c = _def();
  return c ? c.diagnostics() : { enabled: false };
}
function middleware() {
  const c = _def();
  if (!c) {
    // Return a no-op middleware so apps can wire it up before init.
    return function noop(_req, _res, next) {
      if (typeof next === 'function') next();
    };
  }
  return c.middleware();
}

module.exports = {
  Client,
  init,
  capture,
  identify,
  captureError,
  log,
  llmCall,
  flush,
  shutdown,
  isEnabled,
  diagnostics,
  middleware,
};
