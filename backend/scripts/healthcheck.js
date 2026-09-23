#!/usr/bin/env node
'use strict';

/**
 * Safe readiness/liveness probe client.
 *
 *   node scripts/healthcheck.js [--ready|--live] [--port 3001]
 *                               [--retries 30] [--interval-ms 1000]
 *                               [--wait-ms 30000] [--url URL] [--quiet]
 *
 * Security properties:
 *  - sends GET requests only and never attaches Authorization/token headers;
 *  - prints a fixed, redacted whitelist of fields (no headers, env or stack);
 *  - repeated invocations/polls cannot mint, consume or leak a token.
 *
 * Exit codes: 0 = ready/ok, 1 = not ready after retries or request error.
 */

const http = require('http');
const { redact } = require('../health/criteria');

function parseArgs(argv) {
  const args = {
    mode: 'ready',
    port: Number(process.env.PORT) || 3001,
    host: '127.0.0.1',
    retries: 30,
    intervalMs: 1000,
    waitMs: null,
    url: null,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--ready') args.mode = 'ready';
    else if (arg === '--live') args.mode = 'live';
    else if (arg === '--port') args.port = Number(next());
    else if (arg === '--host') args.host = next();
    else if (arg === '--retries') args.retries = Number(next());
    else if (arg === '--interval-ms') args.intervalMs = Number(next());
    else if (arg === '--wait-ms') args.waitMs = Number(next());
    else if (arg === '--url') args.url = next();
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: healthcheck [--ready|--live] [--port 3001] [--host 127.0.0.1]\n'
        + '                    [--retries 30] [--interval-ms 1000] [--wait-ms N]\n'
        + '                    [--url http://host:port/health/ready] [--quiet]\n'
        + 'No authentication header is ever sent. Exit 0 when ready, 1 otherwise.\n'
      );
      process.exit(0);
    }
  }

  if (args.waitMs != null) {
    args.retries = Math.max(1, Math.ceil(args.waitMs / args.intervalMs));
  }
  return args;
}

/** Fixed whitelist of fields that may be printed. Everything else is dropped. */
function sanitize(body) {
  const out = {};
  const scalar = ['ready', 'status', 'port', 'checked_at', 'timestamp',
    'startup_elapsed_ms', 'startup_wait_limit_ms', 'failed_checks', 'retry',
    'uptime_s'];
  for (const key of scalar) {
    if (body[key] !== undefined) out[key] = redact(body[key]);
  }
  if (body.checks && typeof body.checks === 'object') {
    out.checks = {};
    for (const [name, check] of Object.entries(body.checks)) {
      out.checks[name] = {};
      for (const key of ['status', 'detail', 'reason', 'retry', 'elapsed_ms']) {
        if (check[key] !== undefined) out.checks[name][key] = redact(check[key]);
      }
    }
  }
  return out;
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON */ }
        resolve({ statusCode: res.statusCode, ok: res.statusCode === 200, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => resolve({ statusCode: 0, ok: false, body: null, error: err.message }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.url
    || `http://${args.host}:${args.port}/health/${args.mode}`;

  let lastResult = null;
  for (let attempt = 1; attempt <= args.retries; attempt += 1) {
    const result = await probe(target); // no headers: no token is attached
    lastResult = result;

    if (result.ok && result.body && (args.mode === 'live' || result.body.ready === true)) {
      if (!args.quiet) {
        process.stdout.write(`${JSON.stringify(sanitize(result.body), null, 2)}\n`);
      }
      process.stdout.write(`health ${args.mode} ok (attempt ${attempt}/${args.retries})\n`);
      return 0;
    }

    if (!args.quiet) {
      const detail = result.body ? sanitize(result.body) : { error: result.error || 'no response body' };
      process.stdout.write(
        `waiting for ${args.mode} (${attempt}/${args.retries}, HTTP ${result.statusCode}): `
        + `${JSON.stringify(detail)}\n`
      );
    }

    if (attempt < args.retries) await sleep(args.intervalMs);
  }

  process.stderr.write(`health ${args.mode} failed after ${args.retries} attempt(s): ${target}\n`);
  if (lastResult && lastResult.body) {
    process.stderr.write(`Inspect the failing check(s) and follow the "retry" guidance, then re-run;\n`);
    process.stderr.write('the endpoint requires no token.\n');
  }
  return 1;
}

main().then((code) => process.exit(code));
