const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const initDb = require('./db/init');
const articlesRouter = require('./routes/articles');
const authRouter = require('./routes/auth');
const healthRouter = require('./routes/health');
const { runHealthChecks } = require('./health');
const { FAILURE_ADVICE } = require('./health/checks');

const app = express();
const PORT = process.env.PORT || 3001;
app.locals.port = PORT;

// Ensure the data directory exists, then initialize the database.
// If storage is not writable the server still starts in a degraded
// state so GET /api/health can report the exact failure condition.
try {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  initDb();
} catch (err) {
  console.error(`[startup] STORAGE_NOT_WRITABLE: ${err.message}`);
  console.error(`[startup] Retry: ${FAILURE_ADVICE.STORAGE_NOT_WRITABLE}`);
}

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/health', healthRouter);

// Tags route
const { getTags } = require('./routes/articles');
app.get('/api/tags', getTags);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  logReadiness(PORT);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[startup] PORT_CONFLICT: port ${PORT} is already in use.`);
    console.error(`[startup] Retry: ${FAILURE_ADVICE.PORT_CONFLICT}`);
  } else {
    console.error(`[startup] Failed to start: ${err.message}`);
  }
  process.exit(1);
});

// Readiness self-check right after startup: verify port, storage,
// initialization and CORS against the unified readiness rules.
async function logReadiness(port) {
  const report = await runHealthChecks({ port });
  for (const check of report.checks) {
    const line = `[health] ${check.name}: ${check.ok ? 'ok' : 'FAIL'} - ${check.detail}`;
    if (check.ok) {
      console.log(line);
    } else {
      console.error(line);
      console.error(`[health] ${check.name} failure=${check.failure} retry: ${check.retry}`);
    }
  }
  console.log(`[health] readiness: ${report.status} (${report.durationMs}ms)`);
}
