'use strict';

/**
 * Shared state between the background startup readiness gate (server.js) and
 * the HTTP readiness entry point (routes/health.js).
 */

const { STARTUP_DEADLINE_MS, STARTUP_POLL_INTERVAL_MS } = require('./criteria');

const state = {
  /** true once listen() has succeeded; the gate only polls after this. */
  listening: false,
  /** last aggregated check report, null until the first suite completes. */
  report: null,
  /** false until the unified rule has accepted one full suite. */
  ready: false,
  /** timestamp (ms epoch) of the successful listen event. */
  listenAt: null,
  /** true once startup exceeded the wait limit. */
  deadlineExceeded: false,
  startupDeadlineMs: STARTUP_DEADLINE_MS,
  pollIntervalMs: STARTUP_POLL_INTERVAL_MS,
};

/** Resolves as soon as ready=true, or rejects after the startup deadline. */
function waitForSettle(timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = state.listenAt || Date.now();
    const attempt = () => {
      if (state.ready) return resolve(state.report);
      const waited = Date.now() - startedAt;
      if (waited >= timeoutMs) {
        return reject(Object.assign(new Error('startup wait limit exceeded'), {
          code: 'STARTUP_DEADLINE_EXCEEDED',
          waited_ms: waited,
          limit_ms: timeoutMs,
        }));
      }
      setTimeout(attempt, Math.min(state.pollIntervalMs, timeoutMs - waited));
    };
    attempt();
  });
}

function timeSinceListenMs() {
  return state.listenAt ? Date.now() - state.listenAt : null;
}

module.exports = { state, waitForSettle, timeSinceListenMs };
