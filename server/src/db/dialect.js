/**
 * Dialect translation.
 *
 * `schema.sql` is written once in a neutral subset; this module renders it for
 * PostgreSQL or SQLite and rewrites `?` placeholders into `$n` for Postgres.
 */

const SUBSTITUTIONS = {
  postgres: {
    PK: 'BIGSERIAL PRIMARY KEY',
    FK: 'BIGINT',
    TS: 'TIMESTAMPTZ',
    NOW: 'NOW()',
    BOOL: 'BOOLEAN',
    TRUE: 'TRUE',
    FALSE: 'FALSE',
    MONEY: 'NUMERIC(12,2)',
    JSON: 'JSONB',
  },
  sqlite: {
    PK: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    FK: 'INTEGER',
    TS: 'TEXT',
    NOW: "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    BOOL: 'INTEGER',
    TRUE: '1',
    FALSE: '0',
    MONEY: 'REAL',
    JSON: 'TEXT',
    // SQLite has no DOUBLE PRECISION / DATE keywords of its own; they are
    // accepted but map onto REAL/TEXT affinities, which is what we want.
  },
};

export function renderSchema(sql, driver) {
  const map = SUBSTITUTIONS[driver];
  if (!map) throw new Error(`Unknown driver: ${driver}`);
  let out = sql.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in map)) throw new Error(`Unmapped schema placeholder: ${match}`);
    return map[key];
  });
  if (driver === 'sqlite') {
    out = out.replace(/\bDOUBLE PRECISION\b/g, 'REAL').replace(/\bDATE\b/g, 'TEXT');
  }
  return out;
}

/**
 * Split a SQL script into individual statements.
 * Aware of single quotes, double quotes, line comments and block comments so a
 * semicolon inside a string or comment is not treated as a separator.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      current += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Rewrite `?` positional placeholders to Postgres `$1..$n`, skipping anything
 * inside string literals, quoted identifiers or comments.
 */
export function toPgPlaceholders(sql) {
  let out = '';
  let index = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export const TABLES_IN_DEPENDENCY_ORDER = [
  'audit_log',
  'reviews',
  'transactions',
  'point_transactions',
  'point_lots',
  'point_packages',
  'subscriptions',
  'gym_plans',
  'gym_settings',
  'booking_nail_colors',
  'booking_items',
  'bookings',
  'field_participants',
  'field_slots',
  'fields',
  'nail_colors',
  'services',
  'chairs',
  'staff',
  'business_hours',
  'businesses',
  'refresh_tokens',
  'users',
];
