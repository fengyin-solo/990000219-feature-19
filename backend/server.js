const express = require('express');
const cors = require('cors');
const path = require('path');
const initDb = require('./db/init');
const { createStorageCheck, runChecks } = require('./health/checks');
const healthState = require('./health/state');
const {
  CHECK_TIMEOUT_MS,
  STARTUP_DEADLINE_MS,
  STARTUP_POLL_INTERVAL_MS,
  RETRY_HINTS,
} = require('./health/criteria');
const articlesRouter = require('./routes/articles');
const authRouter = require('./routes/auth');
const healthRouter = require('./routes/health');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = path.join(__dirname, 'data');

// Middleware
app.use(cors());
app.use(express.json());

// Safe runtime check entry points (unauthenticated, read-only, no token leak)
app.use('/health', healthRouter);

// Routes (addresses unchanged)
app.use('/api/auth', authRouter);
app.use('/api/articles', articlesRouter);

// Tags route
const { getTags } = require('./routes/articles');
app.get('/api/tags', getTags);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  // --- Preflight: data storage must exist and be writable ------------------
  // Fail fast with an explicit cause and retry path instead of crashing later
  // inside better-sqlite3 (EACCES / EROFS / ENOSPC are named in the result).
  const storageResult = await createStorageCheck(DATA_DIR)();
  if (storageResult.status !== 'pass') {
    console.error(`[startup] Storage preflight failed: ${storageResult.reason}`);
    console.error(`[startup] Recovery: ${storageResult.retry}`);
    process.exit(1);
  }

  // --- Database initialization ---------------------------------------------
  // The schema initialization result is re-verified later by the database check.
  try {
    initDb();
  } catch (err) {
    console.error('[startup] Database initialization failed:', err.message);
    console.error(`[startup] Recovery: ${RETRY_HINTS.database}`);
    process.exit(1);
  }

  const server = app.listen(PORT);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Port conflict: state the failure condition and how to retry, then stop.
      console.error(`[startup] Port ${PORT} is already in use (EADDRINUSE).`);
      console.error('[startup] Failure condition: another process is holding the port.');
      console.error(`[startup] Recovery: stop that process (e.g. lsof -i :${PORT}) and restart,`);
      console.error('           or start on a free port: PORT=<free-port> npm start');
    } else {
      console.error('[startup] Failed to start HTTP server:', err.message);
    }
    process.exit(1);
  });

  server.on('listening', () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // --- Startup readiness gate --------------------------------------------
    // After listen succeeds, re-run the unified checks until every check
    // passes or the startup wait limit is reached. The app keeps serving
    // /health in either case, so operators can poll for the exact failure.
    healthState.state.listening = true;
    healthState.state.listenAt = Date.now();

    const poll = async () => {
      let report;
      try {
        report = await runChecks({
          port: PORT,
          dataDir: DATA_DIR,
          timeoutMs: CHECK_TIMEOUT_MS,
        });
      } catch (err) {
        console.error('[startup] readiness gate error:', err.message);
        return;
      }

      healthState.state.report = report;

      if (report.ready) {
        if (!healthState.state.ready) {
          healthState.state.ready = true;
          const elapsed = Date.now() - healthState.state.listenAt;
          console.log(`[startup] Readiness checks passed after ${elapsed}ms (port, storage, database, CORS)`);
        }
        return; // keep the last good report; stop background polling
      }

      const elapsed = Date.now() - healthState.state.listenAt;

      if (elapsed >= STARTUP_DEADLINE_MS) {
        if (!healthState.state.deadlineExceeded) {
          healthState.state.deadlineExceeded = true;
          console.error(`[startup] Readiness wait limit (${STARTUP_DEADLINE_MS}ms) exceeded.`);
          console.error(`[startup] Failing check(s): ${(report.failed || []).join(', ') || 'unknown'}`);
          for (const name of report.failed || []) {
            const check = report.checks[name];
            console.error(`[startup]   - ${name}: ${check.reason || check.status}`);
            if (check.retry) console.error(`[startup]     retry: ${check.retry}`);
          }
          console.error('[startup] Recovery: resolve the failing check(s), then poll');
          console.error(`           GET http://localhost:${PORT}/health/ready (no token required),`);
          console.error('           or restart the service after fixing the cause.');
        }
        // Past the deadline, poll less aggressively but still recover:
        // a later passing suite flips the service to ready.
        setTimeout(poll, Math.max(STARTUP_POLL_INTERVAL_MS * 4, 2000)).unref();
        return;
      }

      setTimeout(poll, STARTUP_POLL_INTERVAL_MS).unref();
    };

    poll();
  });
}

start();

module.exports = app;
