'use strict';

const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  console: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  global: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', fetch: 'readonly', WebSocket: 'readonly',
  location: 'readonly', history: 'readonly', navigator: 'readonly', console: 'readonly',
  sessionStorage: 'readonly', localStorage: 'readonly', FormData: 'readonly', Blob: 'readonly',
  URL: 'readonly', alert: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  getComputedStyle: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['server.js', 'setup.js', 'eslint.config.js', 'lib/**/*.js', 'auth/**/*.js', 'wireguard/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
  },
  {
    // Browser SPA: functions are invoked from inline HTML handlers, so eslint
    // can't see their use sites; don't flag them as unused. The console pane
    // strips ANSI escape codes, which needs a control-char regex.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    rules: { 'no-unused-vars': 'off', 'no-control-regex': 'off' },
  },
];
