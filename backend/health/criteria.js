'use strict';

/**
 * Unified readiness criteria for the blog service.
 *
 * Every readiness decision (startup gate, HTTP endpoint, CLI probe) uses the
 * same constants, the same per-check timeout wrapper and the same
 * evaluateChecks() rule, so "ready" always means exactly the same thing.
 */

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Per-check timeout: a single check running longer than this is "timeout". */
const CHECK_TIMEOUT_MS = intEnv('HEALTH_CHECK_TIMEOUT_MS', 2000);

/** Startup wait limit: all checks must pass within this long after listen(). */
const STARTUP_DEADLINE_MS = intEnv('HEALTH_STARTUP_DEADLINE_MS', 15000);

/** How often the background startup gate re-runs the full check suite. */
const STARTUP_POLL_INTERVAL_MS = intEnv('HEALTH_STARTUP_POLL_INTERVAL_MS', 500);

const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  TIMEOUT: 'timeout',
});

/** Readiness is the conjunction of exactly these checks, in this order. */
const CHECK_NAMES = Object.freeze(['port', 'storage', 'database', 'cors']);

/** Failure-condition recovery guidance, keyed by check / failure class. */
const RETRY_HINTS = Object.freeze({
  port:
    'Restart the service. If startup failed with EADDRINUSE, stop the process ' +
    'holding the port (lsof -i :PORT, or netstat -ano | findstr PORT on Windows) ' +
    'and restart, or start on another port with PORT=<free-port>.',
  storage:
    'Make the data directory writable and ensure the disk is not full or '
    + 'read-only (EACCES/EROFS/ENOSPC), then restart the service and re-check.',
  database:
    'Restart the service so schema initialization runs again. If the failure '
    + 'persists, verify the data directory is writable and run "npm run seed" '
    + 'to recreate the schema.',
  cors:
    'Verify the CORS middleware (and any reverse proxy in front of it) returns '
    + 'a matching Access-Control-Allow-Origin header, restart the service, then '
    + 'poll /health/ready again.',
  timeout:
    'The check exceeded its time limit without returning a result. Confirm the '
    + 'host is responsive, raise HEALTH_CHECK_TIMEOUT_MS if it is slow, and retry.',
  startup:
    'Fix the failing check(s) listed below, then poll GET /health/ready again '
    + '(the endpoint requires no token), or restart the service after the cause '
    + 'is resolved.',
  default:
    'Inspect the failing check, resolve its cause, then poll GET /health/ready again.',
});

const SECRET_PATTERNS = [
  /(bearer\s+)[a-z0-9._~+/=-]+/gi,
  /((?:access_)?token["'=\s:]+)[a-z0-9._~+/=-]{8,}/gi,
];

/** Defensive redaction: health output must never carry credentials/tokens. */
function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '$1[REDACTED]');
  }
  return out;
}

/**
 * Run one check with the unified timeout rule.
 * `run` may be sync or async and should resolve to
 * { status, detail? | reason?, retry? }. It never rejects to the caller:
 * thrown errors become status=fail and a slow check becomes status=timeout.
 */
function withTimeout(name, run, timeoutMs = CHECK_TIMEOUT_MS) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  let timer;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        name,
        status: STATUS.TIMEOUT,
        reason: `Check "${name}" did not complete within ${timeoutMs}ms`,
        retry: RETRY_HINTS.timeout,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  const workPromise = Promise.resolve()
    .then(run)
    .then((result) => ({ name, ...result }))
    .catch((err) => ({
      name,
      status: STATUS.FAIL,
      reason: err instanceof Error ? err.message : String(err),
      retry: RETRY_HINTS[name] || RETRY_HINTS.default,
    }));

  return Promise.race([workPromise, timeoutPromise])
    .then((check) => ({ ...check, elapsed_ms: elapsedMs() }))
    .finally(() => clearTimeout(timer));
}

/**
 * Unified judgment rule: ready only when every required check passed.
 * A missing result, a hard failure, or a timeout all count as not ready.
 */
function evaluateChecks(checksMap) {
  const results = CHECK_NAMES.map((name) => checksMap[name]);
  const missing = CHECK_NAMES.filter((name) => !checksMap[name]);
  const failed = CHECK_NAMES.filter(
    (name) => checksMap[name] && checksMap[name].status !== STATUS.PASS
  );
  return {
    ready: missing.length === 0 && failed.length === 0,
    failed,
    missing,
    results,
  };
}

/**
 * Build the public, whitelisted view of a readiness report.
 * Only fixed scalar fields per check are copied through; request headers,
 * environment, stack traces and credentials can never appear here.
 */
function publicReport(report, extra = {}) {
  const checks = {};
  for (const name of CHECK_NAMES) {
    const source = (report && report.checks && report.checks[name]) || {};
    checks[name] = {
      status: STATUS[source.status && source.status.toUpperCase()] || 'unknown',
      detail: source.detail ? redact(source.detail) : undefined,
      reason: source.reason ? redact(source.reason) : undefined,
      retry: source.retry ? redact(source.retry) : undefined,
      elapsed_ms: typeof source.elapsed_ms === 'number' ? source.elapsed_ms : null,
    };
    for (const key of Object.keys(checks[name])) {
      if (checks[name][key] === undefined) delete checks[name][key];
    }
  }

  return {
    ...extra,
    ready: Boolean(report && report.ready),
    port: report && report.port != null ? report.port : null,
    checks,
    checked_at: report && report.checked_at ? report.checked_at : null,
  };
}

module.exports = {
  STATUS,
  CHECK_NAMES,
  CHECK_TIMEOUT_MS,
  STARTUP_DEADLINE_MS,
  STARTUP_POLL_INTERVAL_MS,
  RETRY_HINTS,
  redact,
  withTimeout,
  evaluateChecks,
  publicReport,
};
