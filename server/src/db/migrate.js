#!/usr/bin/env node
/**
 * Create (or recreate) the schema.
 *
 *   node src/db/migrate.js            create missing tables
 *   node src/db/migrate.js --fresh    drop everything first
 */
import { initDb, closeDb } from './index.js';
import { config } from '../config.js';

const fresh = process.argv.includes('--fresh');

const db = await initDb();
console.log(`[migrate] driver=${db.driver}${db.driver === 'sqlite' ? ` file=${config.db.sqliteFile}` : ''}`);

if (fresh) {
  console.log('[migrate] dropping existing tables');
  await db.dropAll();
}

await db.migrate();

const tables = await db.all(
  db.driver === 'postgres'
    ? `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    : `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
);
console.log(`[migrate] ${tables.length} tables ready: ${tables.map((t) => t.name).join(', ')}`);

await closeDb();
