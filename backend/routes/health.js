'use strict';

/**
 * Safe runtime check entry points.
 *
 *   GET /health/live  - liveness: the process is up (never gated by readiness)
 *   GET /health/ready - readiness: unified port / storage / database / CORS
 *                       rule; supports ?fresh=1 to re-run the suite on demand
 *
 * Security properties:
 *  - unauthenticated and read-only (no token is ever needed or inspected);
 *  - no Authorization header, JWT, request headers, env vars or stack traces
 *    are echoed back (the response is built through criteria.publicReport);
 *  - Cache-Control: no-store so probes are never cached/proxied;
 *  - only GET/HEAD are accepted, so the entry cannot be used for state changes;
 *  - repeated polling cannot mint, consume or leak tokens.
 *
 * Existing application endpoints (/api/...) are not affected.
 */

const express = require('express');
const { state, timeSinceListenMs } = require('../health/state');
const { runChecks } = require('../health/checks');
const {
  CHECK_TIMEOUT_MS,
  STARTUP_DEADLINE_MS,
  RETRY_HINTS,
  publicReport,
} = require('../health/criteria');

const router = express.Router();

const startedAt = Date.now();

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('X-Content-Type-Options', 'nosniff');
}

router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    noStore(res);
    return res.status(405).json({
      error: 'method_not_allowed',
      retry: 'The health entry is read-only; use GET or HEAD.',
    });
  }
  next();
});

// GET /health/live
router.get('/live', (req, res) => {
  noStore(res);
  res.json({
    status: 'ok',
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// GET /health/ready[?fresh=1]
router.get('/ready', async (req, res) => {
  noStore(res);

  const wantFresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const port = req.socket.localPort || Number(process.env.PORT) || 3001;
  const dataDir = require('path').join(__dirname, '..', 'data');

  let report = state.report;

  if (wantFresh || !report) {
    try {
      report = await runChecks({
        port,
        dataDir,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      if (!wantFresh && !state.report) state.report = report;
    } catch (err) {
      // Defensive: checks normally fail soft. Never expose internals.
      console.error('[health] ready endpoint error:', err && err.message);
      return res.status(503).json({
        ready: false,
        status: 'error',
        retry: RETRY_HINTS.default,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const waitedMs = timeSinceListenMs();

  // Startup wait limit exceeded while still not ready: state the failure
  // condition explicitly, but keep serving so operators can poll for recovery.
  if (!report.ready && !state.ready && waitedMs != null && waitedMs > STARTUP_DEADLINE_MS) {
    const failedNames = report.failed && report.failed.length ? report.failed : null;
    return res.status(503).json(publicReport(report, {
      status: 'startup_deadline_exceeded',
      startup_wait_limit_ms: STARTUP_DEADLINE_MS,
      startup_elapsed_ms: waitedMs,
      failed_checks: failedNames,
      retry:
        'Readiness did not pass within the startup wait limit. Resolve the '
        + `failed check(s) (${failedNames ? failedNames.join(', ') : 'unknown'}) `
        + 'using the per-check "retry" guidance and poll this URL again; '
        + 'no token is required. Restart the service after fixing the cause.',
      timestamp: new Date().toISOString(),
    }));
  }

  if (!report.ready) {
    return res.status(503).json(publicReport(report, {
      status: state.ready ? 'degraded' : 'starting',
      startup_elapsed_ms: waitedMs,
      startup_wait_limit_ms: STARTUP_DEADLINE_MS,
      retry:
        'Service is not ready yet; one or more checks have not passed. '
        + `Retry GET /health/ready after a short wait (no token required). ${RETRY_HINTS.startup}`,
      timestamp: new Date().toISOString(),
    }));
  }

  return res.status(200).json(publicReport(report, {
    status: 'ready',
    startup_elapsed_ms: waitedMs,
    timestamp: new Date().toISOString(),
  }));
});

module.exports = router;
