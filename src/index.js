'use strict';

// Public entry point. Exposes both the functional API (recommended) and the
// Client class for users who prefer explicit instances.
const {
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
} = require('./client');

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
module.exports.default = module.exports;
