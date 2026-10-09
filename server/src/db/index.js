/**
 * Database access layer.
 *
 * One API over two engines:
 *
 *   • PostgreSQL — the production target. Uses the official `pg` package when
 *     it is installed, and otherwise falls back to the built-in wire-protocol
 *     driver in `pgwire.js`, so the project runs against Postgres even where
 *     dependencies cannot be installed.
 *   • SQLite — zero-setup development and tests, via Node's built-in
 *     `node:sqlite`.
 *
 * Queries are always written with `?` placeholders; the Postgres adapter
 * rewrites them to `$n`. Both adapters normalise result values to the same
 * JavaScript types (timestamps as ISO-8601 strings, numerics as numbers, ids as
 * numbers) so application code never needs to know which engine is behind it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { toPgPlaceholders, renderSchema, splitStatements, TABLES_IN_DEPENDENCY_ORDER } from './dialect.js';
import { PgPool, parseConnectionUrl } from './pgwire.js';

const SCHEMA_PATH = path.join(import.meta.dirname, 'schema.sql');

/** Columns stored as 0/1 in SQLite; see `bool()` for reading them back. */
export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

/** Normalise a value for binding, shared by both adapters. */
function normaliseBind(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// ===========================================================================
// SQLite adapter
// ===========================================================================
class SqliteAdapter {
  driver = 'sqlite';
  /** SQLite serialises writers itself, so row locking is a no-op. */
  forUpdate = '';

  constructor(db) {
    this.db = db;
  }

  static async open(file) {
    const { DatabaseSync } = await import('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    return new SqliteAdapter(db);
  }

  #bind(params) {
    return (params || []).map((raw) => {
      const value = normaliseBind(raw);
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
        return JSON.stringify(value);
      }
      return value;
    });
  }

  async query(sql, params) {
    const statement = this.db.prepare(sql);
    const bound = this.#bind(params);
    // `all()` works for SELECT and for writes with RETURNING; `run()` is used
    // for writes without it so we still get changes/lastInsertRowid.
    const isReturning = /\breturning\b/i.test(sql);
    const isSelect = /^\s*(select|with|pragma)\b/i.test(sql);
    if (isSelect || isReturning) {
      const rows = statement.all(...bound).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length, lastInsertId: null };
    }
    const result = statement.run(...bound);
    return {
      rows: [],
      rowCount: Number(result.changes ?? 0),
      lastInsertId: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
    };
  }

  async exec(script) {
    this.db.exec(script);
    return { rows: [], rowCount: 0 };
  }

  async begin() {
    this.db.exec('BEGIN IMMEDIATE');
    return this;
  }
  async commit() {
    this.db.exec('COMMIT');
  }
  async rollback() {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
  }
  release() {}
  async close() {
    this.db.close();
  }
}

// ===========================================================================
// Postgres adapters
// ===========================================================================

/** Shared value normalisation so `pg` matches the built-in driver exactly. */
function configurePgTypes(pg) {
  const toIso = (text) => {
    if (text == null) return null;
    let value = text.replace(' ', 'T');
    if (/[+-]\d{2}$/.test(value)) value = `${value}:00`;
    else if (!/[Zz]|[+-]\d{2}:\d{2}$/.test(value)) value = `${value}Z`;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
  };
  pg.types.setTypeParser(1114, toIso); // timestamp
  pg.types.setTypeParser(1184, toIso); // timestamptz
  pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'
  pg.types.setTypeParser(1700, Number); // numeric
  pg.types.setTypeParser(20, (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : BigInt(v);
  }); // int8
}

class PgPackageAdapter {
  driver = 'postgres';
  forUpdate = ' FOR UPDATE';

  constructor(pool, client = null) {
    this.pool = pool;
    this.client = client;
  }

  static async open(url, poolSize) {
    const pg = (await import('pg')).default ?? (await import('pg'));
    configurePgTypes(pg);
    const pool = new pg.Pool({ connectionString: url, max: poolSize });
    // Fail fast on a bad connection string rather than at first request.
    const probe = await pool.connect();
    probe.release();
    return new PgPackageAdapter(pool);
  }

  get #executor() {
    return this.client ?? this.pool;
  }

  async query(sql, params) {
    const result = await this.#executor.query(
      toPgPlaceholders(sql),
      (params || []).map(normaliseBind),
    );
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows?.length || 0),
      lastInsertId: null,
    };
  }

  async exec(script) {
    await this.#executor.query(script);
    return { rows: [], rowCount: 0 };
  }

  async begin() {
    const client = await this.pool.connect();
    await client.query('BEGIN');
    return new PgPackageAdapter(this.pool, client);
  }
  async commit() {
    await this.client.query('COMMIT');
  }
  async rollback() {
    try {
      await this.client.query('ROLLBACK');
    } catch {
      /* connection already gone */
    }
  }
  release() {
    this.client?.release();
  }
  async close() {
    await this.pool.end();
  }
}

class PgWireAdapter {
  driver = 'postgres';
  forUpdate = ' FOR UPDATE';

  constructor(pool, conn = null) {
    this.pool = pool;
    this.conn = conn;
  }

  static async open(url, poolSize) {
    const options = parseConnectionUrl(url);
    const pool = new PgPool({ ...options, max: poolSize });
    const probe = await pool.acquire();
    pool.release(probe);
    return new PgWireAdapter(pool);
  }

  async query(sql, params) {
    const text = toPgPlaceholders(sql);
    const bound = (params || []).map(normaliseBind);
    const result = this.conn
      ? await this.conn.query(text, bound)
      : await this.pool.query(text, bound);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0, lastInsertId: null };
  }

  async exec(script) {
    if (this.conn) {
      const result = await this.conn.exec(script);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
    }
    const result = await this.pool.exec(script);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  }

  async begin() {
    const conn = await this.pool.acquire();
    await conn.exec('BEGIN');
    return new PgWireAdapter(this.pool, conn);
  }
  async commit() {
    await this.conn.exec('COMMIT');
  }
  async rollback() {
    try {
      await this.conn.exec('ROLLBACK');
    } catch {
      /* connection already gone */
    }
  }
  release() {
    if (this.conn) this.pool.release(this.conn);
  }
  async close() {
    await this.pool.end();
  }
}

// ===========================================================================
// Public facade
// ===========================================================================
class Database {
  constructor(adapter) {
    this.adapter = adapter;
    this.driver = adapter.driver;
    this.forUpdate = adapter.forUpdate;
  }

  async query(sql, params = []) {
    if (config.db.logQueries) {
      console.log('[sql]', sql.replace(/\s+/g, ' ').trim().slice(0, 160), params);
    }
    return this.adapter.query(sql, params);
  }

  /** First row, or null. */
  async get(sql, params = []) {
    const { rows } = await this.query(sql, params);
    return rows[0] ?? null;
  }

  /** All rows. */
  async all(sql, params = []) {
    const { rows } = await this.query(sql, params);
    return rows;
  }

  /** Write; returns `{ rowCount }`. */
  async run(sql, params = []) {
    return this.query(sql, params);
  }

  async exec(script) {
    return this.adapter.exec(script);
  }

  /** A single scalar value from the first row. */
  async value(sql, params = []) {
    const row = await this.get(sql, params);
    if (!row) return null;
    return Object.values(row)[0];
  }

  /** INSERT ... RETURNING *, built from a plain object. */
  async insert(table, data) {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => k);
    const placeholders = entries.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const { rows } = await this.query(sql, entries.map(([, v]) => v));
    return rows[0] ?? null;
  }

  /** UPDATE ... WHERE id = ? RETURNING *; ignores undefined fields. */
  async update(table, id, data) {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (!entries.length) return this.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    const assignments = entries.map(([k]) => `${k} = ?`).join(', ');
    const sql = `UPDATE ${table} SET ${assignments} WHERE id = ? RETURNING *`;
    const { rows } = await this.query(sql, [...entries.map(([, v]) => v), id]);
    return rows[0] ?? null;
  }

  async delete(table, id) {
    const { rowCount } = await this.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return rowCount > 0;
  }

  /**
   * Run `fn` inside a transaction on a dedicated connection.
   * Commits on resolve, rolls back on throw.
   */
  async transaction(fn) {
    const txAdapter = await this.adapter.begin();
    const tx = new Database(txAdapter);
    try {
      const result = await fn(tx);
      await txAdapter.commit();
      return result;
    } catch (err) {
      await txAdapter.rollback();
      throw err;
    } finally {
      txAdapter.release();
    }
  }

  /** Create every table. */
  async migrate() {
    const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const sql = renderSchema(raw, this.driver);
    for (const statement of splitStatements(sql)) {
      await this.exec(statement);
    }
  }

  /** Drop every table (used by `--fresh` and by the test harness). */
  async dropAll() {
    if (this.driver === 'postgres') {
      await this.exec(
        `DROP TABLE IF EXISTS ${TABLES_IN_DEPENDENCY_ORDER.join(', ')} CASCADE`,
      );
      return;
    }
    await this.exec('PRAGMA foreign_keys = OFF');
    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      await this.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await this.exec('PRAGMA foreign_keys = ON');
  }

  /** Remove all rows but keep the tables. */
  async truncateAll() {
    if (this.driver === 'postgres') {
      await this.exec(
        `TRUNCATE ${TABLES_IN_DEPENDENCY_ORDER.join(', ')} RESTART IDENTITY CASCADE`,
      );
      return;
    }
    await this.exec('PRAGMA foreign_keys = OFF');
    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      await this.exec(`DELETE FROM ${table}`);
    }
    await this.exec("DELETE FROM sqlite_sequence");
    await this.exec('PRAGMA foreign_keys = ON');
  }

  async close() {
    await this.adapter.close();
  }
}

let instance = null;

/** Open the configured database (idempotent). */
export async function initDb(overrides = {}) {
  if (instance) return instance;
  const driver = overrides.driver || config.db.driver;
  const poolSize = overrides.poolSize || config.db.poolSize;
  let adapter;

  if (driver === 'postgres') {
    const url = overrides.url || config.db.url;
    if (!url) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    try {
      adapter = await PgPackageAdapter.open(url, poolSize);
    } catch (err) {
      const missing =
        err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:module|package) 'pg'/.test(err?.message || '');
      if (!missing) throw err;
      console.warn('[db] `pg` is not installed — using the built-in Postgres driver.');
      adapter = await PgWireAdapter.open(url, poolSize);
    }
  } else if (driver === 'sqlite') {
    adapter = await SqliteAdapter.open(overrides.file || config.db.sqliteFile);
  } else {
    throw new Error(`Unsupported DB_DRIVER: ${driver}`);
  }

  instance = new Database(adapter);
  return instance;
}

export function getDb() {
  if (!instance) throw new Error('Database not initialised — call initDb() first');
  return instance;
}

export async function closeDb() {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

export { Database };
