const {
  CHECK_TIMEOUT_MS,
  WAIT_LIMIT_MS,
  FAILURE_ADVICE,
  checks
} = require('./checks');

// Run one check bounded by its own timeout and the overall waiting limit.
function runWithLimit(name, fn, timeoutMs, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve({
      name,
      ok: false,
      detail: 'skipped: overall waiting limit already exceeded',
      failure: 'WAIT_LIMIT_EXCEEDED',
      retry: FAILURE_ADVICE.WAIT_LIMIT_EXCEEDED
    });
  }

  const limit = Math.min(timeoutMs, remaining);
  const bounded = limit < timeoutMs ? 'WAIT_LIMIT_EXCEEDED' : 'CHECK_TIMEOUT';

  return Promise.race([
    Promise.resolve()
      .then(fn)
      .catch((err) => ({
        name,
        ok: false,
        detail: `unexpected error: ${err.message}`,
        failure: 'CHECK_ERROR',
        retry: FAILURE_ADVICE.CHECK_ERROR
      })),
    new Promise((resolve) => setTimeout(() => resolve({
      name,
      ok: false,
      detail: `check did not finish within ${limit}ms`,
      failure: bounded,
      retry: FAILURE_ADVICE[bounded]
    }), limit))
  ]);
}

// Run all readiness checks and aggregate them under the unified rules:
// the service is ready only when every check passes.
async function runHealthChecks({ port, timeoutMs = CHECK_TIMEOUT_MS, waitLimitMs = WAIT_LIMIT_MS } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + waitLimitMs;

  const results = await Promise.all([
    runWithLimit('port', () => checks.checkPort(port), timeoutMs, deadline),
    runWithLimit('storage', () => checks.checkStorage(), timeoutMs, deadline),
    runWithLimit('init', () => checks.checkInit(), timeoutMs, deadline),
    runWithLimit('cors', () => checks.checkCors(port), timeoutMs, deadline)
  ]);

  const ok = results.every((r) => r.ok);
  const report = {
    status: ok ? 'ok' : 'error',
    ok,
    durationMs: Date.now() - startedAt,
    checks: results
  };

  if (!ok) {
    report.retry = 'Service is not ready. Fix the failed checks above, then retry GET /api/health — it is read-only and safe to repeat.';
  }

  return report;
}

module.exports = { runHealthChecks };
