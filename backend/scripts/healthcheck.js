#!/usr/bin/env node
// Polls GET /api/health until the service is ready or the waiting limit
// is reached. Exit 0 when ready, exit 1 with failure conditions and
// retry instructions otherwise.
//
// Usage: node scripts/healthcheck.js [--port 3001] [--retries 10] [--interval 1000] [--timeout 2000]
const http = require('http');

const DEFAULTS = {
  port: parseInt(process.env.PORT, 10) || 3001,
  retries: 10,
  interval: 1000,
  timeout: 2000
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (key in DEFAULTS) opts[key] = parseInt(argv[i + 1], 10);
  }
  return opts;
}

function fetchHealth({ port, timeout }) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-JSON response */ }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeout}ms`)));
    req.on('error', (err) => resolve({ error: err }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };
  let lastFailures = [];

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const result = await fetchHealth(opts);

    if (result.body && result.body.ok) {
      console.log(`[healthcheck] ready after ${attempt} attempt(s)`);
      for (const check of result.body.checks) {
        console.log(`[healthcheck]   ${check.name}: ok - ${check.detail}`);
      }
      process.exit(0);
    }

    if (result.error) {
      console.error(`[healthcheck] attempt ${attempt}/${opts.retries}: unreachable (${result.error.code || result.error.message})`);
      lastFailures = [{ failure: 'PORT_UNREACHABLE' }];
    } else if (result.body && Array.isArray(result.body.checks)) {
      lastFailures = result.body.checks.filter((c) => !c.ok);
      const summary = lastFailures.map((c) => `${c.name}(${c.failure})`).join(', ');
      console.error(`[healthcheck] attempt ${attempt}/${opts.retries}: not ready - ${summary}`);
    } else {
      console.error(`[healthcheck] attempt ${attempt}/${opts.retries}: unexpected response (HTTP ${result.statusCode})`);
    }

    if (attempt < opts.retries) await sleep(opts.interval);
  }

  const waited = Math.ceil((opts.retries * opts.interval) / 1000);
  console.error(`[healthcheck] WAIT_LIMIT_EXCEEDED: service not ready after ${opts.retries} attempts (~${waited}s).`);
  for (const failure of lastFailures) {
    if (failure.retry) console.error(`[healthcheck]   ${failure.name || 'port'}: ${failure.retry}`);
  }
  console.error('[healthcheck] Retry: fix the conditions above, make sure the backend is running (npm run dev), then re-run "npm run healthcheck".');
  process.exit(1);
}

main();
