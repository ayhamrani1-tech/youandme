#!/usr/bin/env node
/**
 * Server entry point.
 */
import { config } from './config.js';
import { initDb, closeDb, getDb } from './db/index.js';
import { createApp } from './app.js';

const db = await initDb();

// A fresh SQLite file would otherwise 500 on the first request; bringing the
// schema up to date on boot keeps `npm start` a single step in development.
const hasUsers = await db
  .get(
    db.driver === 'postgres'
      ? "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'"
      : "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  )
  .catch(() => null);
if (!hasUsers) {
  console.log('[boot] schema missing — creating tables');
  await db.migrate();
}

const app = createApp();
const server = await app.listen(config.port, config.host);

const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
console.log(`
  you&me API
  ───────────────────────────────────────────
  env       ${config.env}
  database  ${db.driver}${db.driver === 'sqlite' ? ` (${config.db.sqliteFile})` : ''}
  api       http://${shown}:${config.port}/api
  health    http://${shown}:${config.port}/api/health
  web       ${config.serveWebDist ? `http://${shown}:${config.port}` : 'served separately'}
`);

async function shutdown(signal) {
  console.log(`\n[${signal}] shutting down`);
  server.close();
  try {
    await closeDb();
  } catch (err) {
    console.error('[shutdown] error closing database:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

export { server, getDb };
