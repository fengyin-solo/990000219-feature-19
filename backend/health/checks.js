const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { getDb, DB_PATH } = require('../db/init');

// Unified determination rules:
// - every check resolves to { name, ok, detail, failure?, retry? }
// - a check that exceeds CHECK_TIMEOUT_MS fails with CHECK_TIMEOUT
// - a run that exceeds WAIT_LIMIT_MS fails remaining checks with WAIT_LIMIT_EXCEEDED
const CHECK_TIMEOUT_MS = 2000;
const WAIT_LIMIT_MS = 5000;

// Failure conditions and how to retry each of them.
const FAILURE_ADVICE = {
  PORT_CONFLICT: 'Port is already in use. Free it (e.g. "lsof -i :<port>") or start with another PORT env, then retry.',
  PORT_UNREACHABLE: 'Server is not accepting connections. Confirm the process is running, then retry the check.',
  STORAGE_NOT_WRITABLE: 'Data directory or database file is not writable. Fix permissions/ownership on backend/data, then retry.',
  INIT_INCOMPLETE: 'Database schema is missing. Run "npm run seed" or restart the server to initialize, then retry.',
  CORS_MISCONFIGURED: 'CORS headers are missing. Ensure the cors middleware is mounted before routes, then retry.',
  CHECK_TIMEOUT: 'A check exceeded its time limit. Retry the check; if it persists, inspect database and system load.',
  WAIT_LIMIT_EXCEEDED: 'Checks did not finish within the waiting limit. Retry later or raise the limit.',
  CHECK_ERROR: 'Unexpected check error. Inspect server logs, then retry the check.'
};

function pass(name, detail) {
  return { name, ok: true, detail };
}

function fail(name, failure, detail) {
  return { name, ok: false, detail, failure, retry: FAILURE_ADVICE[failure] || FAILURE_ADVICE.CHECK_ERROR };
}

// Port: the server must accept TCP connections on its configured port.
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.end();
      resolve(pass('port', `port ${port} accepting connections`));
    });
    socket.once('error', (err) => {
      socket.destroy();
      resolve(fail('port', 'PORT_UNREACHABLE', `cannot connect to port ${port}: ${err.code || err.message}`));
    });
  });
}

// Storage: data directory and database file must be writable, database readable.
// The write probe uses a temp file that is always removed, so repeated checks
// leave no side effects.
function checkStorage() {
  const name = 'storage';
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      return fail(name, 'STORAGE_NOT_WRITABLE', `data directory missing: ${dir}`);
    }

    const probe = path.join(dir, `.health-probe-${process.pid}`);
    try {
      fs.writeFileSync(probe, 'ok');
    } finally {
      try { fs.unlinkSync(probe); } catch { /* probe may not exist */ }
    }

    if (fs.existsSync(DB_PATH)) {
      fs.accessSync(DB_PATH, fs.constants.W_OK);
    }

    getDb().prepare('SELECT 1').get();
    return pass(name, 'data directory writable, database readable');
  } catch (err) {
    return fail(name, 'STORAGE_NOT_WRITABLE', `storage check failed: ${err.message}`);
  }
}

// Initialization: the articles table created by initDb() must exist.
function checkInit() {
  const name = 'init';
  try {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles'")
      .get();
    if (!row) {
      return fail(name, 'INIT_INCOMPLETE', 'articles table is missing');
    }
    const { count } = getDb().prepare('SELECT COUNT(*) AS count FROM articles').get();
    return pass(name, `articles table present (${count} rows)`);
  } catch (err) {
    return fail(name, 'INIT_INCOMPLETE', `init check failed: ${err.message}`);
  }
}

// CORS: responses must carry Access-Control-Allow-Origin so the frontend
// origin can call the API. Probed against the side-effect-free ping route.
function checkCors(port) {
  const name = 'cors';
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/health/ping',
      headers: { Origin: 'http://localhost:5173' }
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const acao = res.headers['access-control-allow-origin'];
        if (acao) {
          resolve(pass(name, `Access-Control-Allow-Origin present (${acao})`));
        } else {
          resolve(fail(name, 'CORS_MISCONFIGURED', 'Access-Control-Allow-Origin header missing'));
        }
      });
    });
    req.on('error', (err) => {
      resolve(fail(name, 'CORS_MISCONFIGURED', `cors probe failed: ${err.code || err.message}`));
    });
  });
}

module.exports = {
  CHECK_TIMEOUT_MS,
  WAIT_LIMIT_MS,
  FAILURE_ADVICE,
  checks: { checkPort, checkStorage, checkInit, checkCors }
};
