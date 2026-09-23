'use strict';

/**
 * The four readiness checks. Each factory returns a thunk compatible with
 * criteria.withTimeout and resolves to { status, detail? } on success or
 * { status: 'fail'|'timeout', reason, retry } on failure.
 *
 * Checks are intentionally read-only and unauthenticated: they never read
 * request headers, tokens or the JWT secret.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { getDb } = require('../db/init');
const { STATUS, RETRY_HINTS } = require('./criteria');

/**
 * 1) Port: the bound HTTP listener must accept a local TCP connection.
 *    Refused connections mean the listener is down; EADDRINUSE itself is a
 *    startup-time condition handled in server.js (listen 'error' event).
 */
function createPortCheck(port, host = '127.0.0.1', timeoutMs) {
  return () =>
    new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish({
        status: STATUS.PASS,
        detail: `listening on ${host}:${port}`,
      }));
      socket.once('timeout', () => finish({
        status: STATUS.TIMEOUT,
        reason: `TCP connect to ${host}:${port} timed out`,
        retry: RETRY_HINTS.timeout,
      }));
      socket.once('error', (err) => finish({
        status: STATUS.FAIL,
        reason: err && err.code ? `TCP connect failed: ${err.code}` : String(err),
        retry:
          err && err.code === 'ECONNREFUSED'
            ? 'Nothing is accepting connections on the port; the listener may '
              + 'have stopped or failed to start. Restart the service, and if '
              + 'startup reported EADDRINUSE, free the conflicting port first '
              + '(lsof -i :PORT) or start on a free port with PORT=<free-port>.'
            : RETRY_HINTS.port,
      }));

      socket.connect(port, host);
    });
}

/**
 * 2) Storage: the data directory must exist and be writable, and the disk
 *    must accept a flushed write. EACCES/EROFS/ENOSPC map to clear causes.
 */
function createStorageCheck(dataDir) {
  // Unique per invocation: the startup preflight and readiness checks run in
  // the same process and must not unlink each other's probe file.
  const probeFile = path.join(
    dataDir,
    `.health-write-probe-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  );

  return async () => {
    let handle;
    try {
      await fsp.mkdir(dataDir, { recursive: true });
      const probe = `healthcheck ${Date.now()} ${os.hostname()}\n`;
      handle = await fsp.open(probeFile, 'w');
      await handle.writeFile(probe, 'utf8');
      await handle.sync(); // flush so ENOSPC surfaces here, not later
      await handle.close();
      await fsp.unlink(probeFile);
      return { status: STATUS.PASS, detail: 'data directory is writable' };
    } catch (err) {
      if (handle) await handle.close().catch(() => undefined);
      // Best-effort cleanup; a probe missing because a concurrent check
      // removed it is not a storage failure.
      await fsp.unlink(probeFile).catch((cleanupErr) => {
        if (cleanupErr.code !== 'ENOENT') throw cleanupErr;
      });

      const code = err && err.code;
      const causeByCode = {
        EACCES: 'permission denied writing to the data directory',
        EPERM: 'operation not permitted on the data directory',
        EROFS: 'data directory is on a read-only filesystem',
        ENOSPC: 'no space left on device',
        EISDIR: 'data path is a directory where a file was expected',
      };
      return {
        status: STATUS.FAIL,
        reason: `${causeByCode[code] || 'write probe failed'} (${code || err.message})`,
        retry: RETRY_HINTS.storage,
      };
    }
  };
}

/**
 * 3) Database initialization result: the articles table must exist
 *    (schema initialization completed) and a read-only integrity query
 *    must succeed.
 */
function createDatabaseCheck() {
  return () => {
    const db = getDb(); // throws if the database could not be opened
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'articles'")
      .get();
    if (!table) {
      return {
        status: STATUS.FAIL,
        reason: 'initialization incomplete: articles table is missing',
        retry: RETRY_HINTS.database,
      };
    }
    db.prepare('SELECT 1 FROM articles LIMIT 1').get();
    return {
      status: STATUS.PASS,
      detail: 'schema initialized; articles table is readable',
    };
  };
}

/**
 * 4) Cross-origin check: an OPTIONS preflight from an allowed origin must
 *    reach the CORS middleware and come back with a matching
 *    Access-Control-Allow-Origin header. This request carries no token.
 */
function createCorsCheck(port, origin = 'http://localhost:5173', timeoutMs) {
  return () =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/tags',
          method: 'OPTIONS',
          timeout: timeoutMs,
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'content-type',
          },
        },
        (res) => {
          res.resume(); // drain, we only inspect headers
          res.once('end', () => {
            const allowOrigin = res.headers['access-control-allow-origin'];
            if (allowOrigin === '*' || allowOrigin === origin) {
              resolve({
                status: STATUS.PASS,
                detail: `preflight allowed (${allowOrigin})`,
              });
            } else {
              resolve({
                status: STATUS.FAIL,
                reason:
                  'preflight response has no matching Access-Control-Allow-Origin'
                  + ` header (got "${allowOrigin || 'none'}")`,
                retry: RETRY_HINTS.cors,
              });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('CORS preflight timed out'));
      });
      req.once('error', (err) => {
        resolve({
          status:
            /timed out/.test(err.message) ? STATUS.TIMEOUT : STATUS.FAIL,
          reason: `CORS preflight failed: ${err.message}`,
          retry: /timed out/.test(err.message) ? RETRY_HINTS.timeout : RETRY_HINTS.cors,
        });
      });
      req.end();
    });
}

/** Run the full suite and aggregate with the single unified rule. */
async function runChecks({ port, dataDir, timeoutMs }) {
  const withTimeout = require('./criteria').withTimeout;
  const checksMap = {};
  const factories = {
    port: createPortCheck(port, '127.0.0.1', timeoutMs),
    storage: createStorageCheck(dataDir),
    database: createDatabaseCheck(),
    cors: createCorsCheck(port, 'http://localhost:5173', timeoutMs),
  };

  await Promise.all(
    Object.keys(factories).map(async (name) => {
      checksMap[name] = await withTimeout(name, factories[name], timeoutMs);
    })
  );

  const { ready, failed } = require('./criteria').evaluateChecks(checksMap);
  return {
    ready,
    port,
    failed,
    checks: checksMap,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  createPortCheck,
  createStorageCheck,
  createDatabaseCheck,
  createCorsCheck,
  runChecks,
};
