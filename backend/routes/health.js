const express = require('express');
const { runHealthChecks } = require('../health');

const router = express.Router();

// Safe check entry point.
// - read-only and idempotent: repeated checks cause no side effects
// - unauthenticated, and the handler never reads or reflects request
//   headers, so tokens sent here can never leak into responses or logs
// - responses are marked no-store so status is never served from cache
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const report = await runHealthChecks({ port: req.app.locals.port });
  res.status(report.ok ? 200 : 503).json(report);
});

// Lightweight liveness probe, also used internally by the CORS check.
router.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'pong' });
});

module.exports = router;
