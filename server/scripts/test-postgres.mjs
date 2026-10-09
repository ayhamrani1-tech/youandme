#!/usr/bin/env node
/**
 * Run the whole test suite against a real PostgreSQL server.
 *
 * The suite is written for an isolated database per test file, so each file is
 * given its own throwaway database. This is what proves the Postgres code path
 * — placeholder rewriting, row locking, type coercion — rather than only the
 * SQLite one.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres node scripts/test-postgres.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb } from '../src/db/index.js';

const adminUrl =
  process.env.DATABASE_URL || 'postgres://youandme:youandme@127.0.0.1:5432/youandme';
const testsDir = path.join(import.meta.dirname, '..', 'tests');
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function run(file, dbName) {
  const url = withDatabase(adminUrl, dbName);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', path.join(testsDir, file)],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          TEST_DB_DRIVER: 'postgres',
          DB_DRIVER: 'postgres',
          DATABASE_URL: url,
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// A connection to the server itself, used only to create and drop databases.
// Passed explicitly rather than through the environment: `config.js` is
// evaluated when it is imported, which is before this line runs.
const control = await initDb({ driver: 'postgres', url: adminUrl });

const results = [];
for (const [index, file] of files.entries()) {
  const dbName = `youandme_test_${index}`;
  console.log(`\n\u001b[36m▶ ${file} → ${dbName}\u001b[0m`);
  await control.exec(`DROP DATABASE IF EXISTS ${dbName}`);
  await control.exec(`CREATE DATABASE ${dbName}`);
  const code = await run(file, dbName);
  results.push({ file, code });
  await control.exec(`DROP DATABASE IF EXISTS ${dbName}`);
}

await closeDb();

console.log('\n\u001b[1mPostgres suite\u001b[0m');
for (const { file, code } of results) {
  console.log(`  ${code === 0 ? '\u001b[32m✓' : '\u001b[31m✗'} ${file}\u001b[0m`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(
  failed.length
    ? `\n\u001b[31m${failed.length} of ${results.length} file(s) failed\u001b[0m`
    : `\n\u001b[32mAll ${results.length} file(s) passed against PostgreSQL\u001b[0m`,
);
process.exit(failed.length ? 1 : 0);
