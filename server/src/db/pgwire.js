/**
 * Minimal PostgreSQL client speaking the v3 frontend/backend protocol directly
 * over a TCP socket — no npm dependency required.
 *
 * This exists only as a fallback: `db/index.js` prefers the official `pg`
 * package when it is installed and uses this when it is not, so the project
 * runs against PostgreSQL in environments where nothing can be installed.
 *
 * Implemented: startup, SCRAM-SHA-256 / MD5 / cleartext / trust auth, optional
 * TLS, the simple query protocol (multi-statement scripts) and the extended
 * query protocol with bound parameters, plus text-format result decoding for
 * the types this schema uses.
 *
 * Reference: https://www.postgresql.org/docs/current/protocol.html
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const PROTOCOL_VERSION = 196608; // 3.0
const SSL_REQUEST_CODE = 80877103;

// ---------------------------------------------------------------------------
// Write buffer
// ---------------------------------------------------------------------------
class Writer {
  constructor() {
    this.chunks = [];
  }
  int8(v) {
    this.chunks.push(Buffer.from([v]));
    return this;
  }
  int16(v) {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(v, 0);
    this.chunks.push(b);
    return this;
  }
  int32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(v, 0);
    this.chunks.push(b);
    return this;
  }
  bytes(buf) {
    this.chunks.push(buf);
    return this;
  }
  cstring(str) {
    this.chunks.push(Buffer.from(String(str ?? ''), 'utf8'), Buffer.from([0]));
    return this;
  }
  build() {
    return Buffer.concat(this.chunks);
  }
}

/** Frame a frontend message: type byte + Int32 length (self-inclusive) + body. */
function frame(type, body) {
  const header = Buffer.allocUnsafe(type ? 5 : 4);
  let offset = 0;
  if (type) header.writeUInt8(type.charCodeAt(0), offset++);
  header.writeInt32BE(body.length + 4, offset);
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// Read buffer
// ---------------------------------------------------------------------------
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  int8() {
    return this.buf.readUInt8(this.pos++);
  }
  int16() {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int32() {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  cstring() {
    const end = this.buf.indexOf(0, this.pos);
    const str = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return str;
  }
  bytes(len) {
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
}

// ---------------------------------------------------------------------------
// Value decoding (text format)
// ---------------------------------------------------------------------------
const OID = {
  BOOL: 16,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  OID: 26,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  NUMERIC: 1700,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  JSONB: 3802,
};

/**
 * Normalise a Postgres timestamp string to an ISO-8601 UTC string so results
 * look identical whichever driver produced them.
 */
function normaliseTimestamp(text, hasZone) {
  let value = text.replace(' ', 'T');
  if (hasZone) {
    // Postgres renders offsets as +03 / +03:30; ISO needs +03:00.
    value = value.replace(/([+-]\d{2})$/, '$1:00');
  } else {
    value += 'Z';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function decodeValue(text, typeOid) {
  if (text === null) return null;
  switch (typeOid) {
    case OID.BOOL:
      return text === 't' || text === 'true';
    case OID.INT2:
    case OID.INT4:
    case OID.OID:
      return Number(text);
    case OID.INT8: {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : BigInt(text);
    }
    case OID.FLOAT4:
    case OID.FLOAT8:
    case OID.NUMERIC:
      return Number(text);
    case OID.JSON:
    case OID.JSONB:
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    case OID.TIMESTAMP:
      return normaliseTimestamp(text, false);
    case OID.TIMESTAMPTZ:
      return normaliseTimestamp(text, true);
    default:
      return text;
  }
}

/** Encode a JS value as a text-format parameter. */
function encodeParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// SCRAM-SHA-256
// ---------------------------------------------------------------------------
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}
function xor(a, b) {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

class ScramSession {
  constructor(password) {
    this.password = password;
    this.clientNonce = crypto.randomBytes(18).toString('base64');
    this.clientFirstBare = `n=*,r=${this.clientNonce}`;
  }
  initialResponse() {
    return `n,,${this.clientFirstBare}`;
  }
  /** Consume server-first-message, produce client-final-message. */
  finalResponse(serverFirst) {
    const attrs = Object.fromEntries(
      serverFirst.split(',').map((pair) => {
        const idx = pair.indexOf('=');
        return [pair.slice(0, idx), pair.slice(idx + 1)];
      }),
    );
    const combinedNonce = attrs.r;
    const salt = Buffer.from(attrs.s, 'base64');
    const iterations = Number(attrs.i);
    if (!combinedNonce || !combinedNonce.startsWith(this.clientNonce)) {
      throw new Error('SCRAM: server nonce does not extend the client nonce');
    }
    const saltedPassword = crypto.pbkdf2Sync(
      Buffer.from(this.password, 'utf8'),
      salt,
      iterations,
      32,
      'sha256',
    );
    const clientKey = hmac(saltedPassword, 'Client Key');
    const storedKey = sha256(clientKey);
    const finalWithoutProof = `c=biws,r=${combinedNonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${finalWithoutProof}`;
    const clientSignature = hmac(storedKey, authMessage);
    const proof = xor(clientKey, clientSignature);
    const serverKey = hmac(saltedPassword, 'Server Key');
    this.expectedServerSignature = hmac(serverKey, authMessage).toString('base64');
    return `${finalWithoutProof},p=${proof.toString('base64')}`;
  }
  verifyFinal(serverFinal) {
    const signature = /(^|,)v=([^,]+)/.exec(serverFinal)?.[2];
    if (signature !== this.expectedServerSignature) {
      throw new Error('SCRAM: server signature mismatch — refusing the connection');
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class PostgresError extends Error {
  constructor(fields) {
    super(fields.M || 'Postgres error');
    this.name = 'PostgresError';
    this.severity = fields.S;
    this.code = fields.C;
    this.detail = fields.D;
    this.hint = fields.H;
    this.constraint = fields.n;
    this.table = fields.t;
    this.column = fields.c;
    this.position = fields.P;
  }
}

function parseErrorFields(reader) {
  const fields = {};
  while (reader.remaining > 1) {
    const code = String.fromCharCode(reader.int8());
    if (code === '\u0000') break;
    fields[code] = reader.cstring();
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
export class PgConnection extends EventEmitter {
  /** Resolvers for the startup handshake, cleared once ReadyForQuery arrives. */
  #startupResolve = null;
  #startupReject = null;

  constructor(options) {
    super();
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.parameters = {};
    this.connected = false;
    /** Queue of pending operations; Postgres is strictly request/response. */
    this.queue = [];
    this.current = null;
    this.closed = false;
  }

  // -- socket plumbing ------------------------------------------------------
  async connect() {
    const { host, port, ssl } = this.options;
    let socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    socket.setNoDelay(true);

    if (ssl) {
      const request = new Writer().int32(8).int32(SSL_REQUEST_CODE).build();
      socket.write(request);
      const reply = await new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
      });
      if (reply.toString('utf8', 0, 1) !== 'S') {
        socket.destroy();
        throw new Error('Postgres server refused the TLS request');
      }
      socket = await new Promise((resolve, reject) => {
        const secure = tls.connect(
          {
            socket,
            servername: host,
            rejectUnauthorized: this.options.sslRejectUnauthorized !== false,
            ca: this.options.sslCa,
          },
          () => resolve(secure),
        );
        secure.once('error', reject);
      });
    }

    this.socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.#fail(err));
    socket.on('close', () => {
      this.closed = true;
      this.#fail(new Error('Postgres connection closed'));
      this.emit('close');
    });

    await this.#startup();
    this.connected = true;
    return this;
  }

  #fail(err) {
    const pending = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.queue = [];
    this.current = null;
    for (const op of pending) op.reject?.(err);
    if (!pending.length) this.emit('error', err);
  }

  #send(buf) {
    if (!this.socket || this.socket.destroyed) throw new Error('Postgres connection is closed');
    this.socket.write(buf);
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      const total = length + 1;
      if (this.buffer.length < total) break;
      const type = String.fromCharCode(this.buffer.readUInt8(0));
      const body = this.buffer.subarray(5, total);
      this.buffer = this.buffer.subarray(total);
      try {
        this.#dispatch(type, new Reader(body));
      } catch (err) {
        this.#fail(err);
        return;
      }
    }
  }

  #dispatch(type, reader) {
    const op = this.current;
    switch (type) {
      case 'R':
        this.#handleAuth(reader);
        return;
      case 'S': {
        const key = reader.cstring();
        this.parameters[key] = reader.cstring();
        return;
      }
      case 'K':
        this.backendPid = reader.int32();
        this.backendSecret = reader.int32();
        return;
      case 'E': {
        const err = new PostgresError(parseErrorFields(reader));
        if (op) op.error = err;
        else this.#fail(err);
        return;
      }
      case 'N':
        this.emit('notice', parseErrorFields(reader));
        return;
      case 'Z': {
        reader.int8(); // transaction status
        if (this.#startupResolve) {
          const resolve = this.#startupResolve;
          this.#startupResolve = null;
          this.#startupReject = null;
          resolve();
          return;
        }
        this.#finishCurrent();
        return;
      }
      case 'T': {
        const count = reader.int16();
        const fields = [];
        for (let i = 0; i < count; i += 1) {
          const name = reader.cstring();
          reader.int32(); // table oid
          reader.int16(); // column attr
          const typeOid = reader.int32();
          reader.int16(); // type size
          reader.int32(); // type modifier
          reader.int16(); // format code
          fields.push({ name, typeOid });
        }
        if (op) {
          op.fields = fields;
          op.rows = [];
        }
        return;
      }
      case 'D': {
        const count = reader.int16();
        const row = {};
        for (let i = 0; i < count; i += 1) {
          const len = reader.int32();
          const field = op?.fields?.[i];
          const raw = len === -1 ? null : reader.bytes(len).toString('utf8');
          if (field) row[field.name] = decodeValue(raw, field.typeOid);
        }
        op?.rows?.push(row);
        return;
      }
      case 'C': {
        const tag = reader.cstring();
        if (op) {
          op.commandTag = tag;
          const match = /^(\w+)(?: (\d+))?(?: (\d+))?$/.exec(tag);
          if (match) {
            op.command = match[1];
            op.rowCount = Number(match[3] ?? match[2] ?? 0);
          }
          // A script may produce several results; keep the last row set.
          op.results.push({
            command: op.command,
            rowCount: op.rowCount,
            rows: op.rows ?? [],
            fields: op.fields ?? [],
          });
          op.rows = [];
          op.fields = null;
        }
        return;
      }
      case 'I': // EmptyQueryResponse
      case '1': // ParseComplete
      case '2': // BindComplete
      case '3': // CloseComplete
      case 'n': // NoData
      case 's': // PortalSuspended
        return;
      case 't': // ParameterDescription
        return;
      case 'A': // NotificationResponse
        reader.int32();
        this.emit('notification', { channel: reader.cstring(), payload: reader.cstring() });
        return;
      case 'G':
      case 'H':
      case 'd':
      case 'c':
        throw new Error('COPY is not supported by the built-in Postgres driver');
      default:
        return;
    }
  }

  #finishCurrent() {
    const op = this.current;
    this.current = null;
    if (op) {
      if (op.error) op.reject(op.error);
      else {
        const last = op.results[op.results.length - 1] ?? {
          command: op.command,
          rowCount: 0,
          rows: [],
          fields: [],
        };
        op.resolve({ ...last, results: op.results });
      }
    }
    this.#drain();
  }

  #drain() {
    if (this.current || !this.queue.length) return;
    const op = this.queue.shift();
    this.current = op;
    op.results = [];
    op.rows = [];
    op.fields = null;
    try {
      this.#send(op.payload);
    } catch (err) {
      this.current = null;
      op.reject(err);
      this.#drain();
    }
  }

  #enqueue(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.#drain();
    });
  }

  // -- startup & auth -------------------------------------------------------
  #startup() {
    const { user, database, applicationName } = this.options;
    const writer = new Writer().int32(PROTOCOL_VERSION);
    writer.cstring('user').cstring(user);
    if (database) writer.cstring('database').cstring(database);
    writer.cstring('application_name').cstring(applicationName || 'youandme');
    writer.cstring('client_encoding').cstring('UTF8');
    writer.int8(0);
    const body = writer.build();
    const packet = Buffer.allocUnsafe(body.length + 4);
    packet.writeInt32BE(body.length + 4, 0);
    body.copy(packet, 4);

    return new Promise((resolve, reject) => {
      this.#startupResolve = resolve;
      this.#startupReject = reject;
      const onError = (err) => {
        if (this.#startupReject) {
          this.#startupReject = null;
          this.#startupResolve = null;
          reject(err);
        }
      };
      this.once('error', onError);
      try {
        this.#send(packet);
      } catch (err) {
        onError(err);
      }
    });
  }

  #handleAuth(reader) {
    const code = reader.int32();
    const password = this.options.password ?? '';
    switch (code) {
      case 0: // AuthenticationOk
        return;
      case 3: // cleartext
        this.#send(frame('p', new Writer().cstring(password).build()));
        return;
      case 5: {
        // md5: md5(md5(password + user) + salt)
        const salt = reader.bytes(4);
        const inner = crypto
          .createHash('md5')
          .update(password + this.options.user, 'utf8')
          .digest('hex');
        const outer = crypto
          .createHash('md5')
          .update(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))
          .digest('hex');
        this.#send(frame('p', new Writer().cstring(`md5${outer}`).build()));
        return;
      }
      case 10: {
        // SASL
        const mechanisms = [];
        while (reader.remaining > 1) {
          const m = reader.cstring();
          if (!m) break;
          mechanisms.push(m);
        }
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          throw new Error(
            `Unsupported SASL mechanisms: ${mechanisms.join(', ')} (built-in driver supports SCRAM-SHA-256)`,
          );
        }
        this.scram = new ScramSession(password);
        const initial = Buffer.from(this.scram.initialResponse(), 'utf8');
        const body = new Writer()
          .cstring('SCRAM-SHA-256')
          .int32(initial.length)
          .bytes(initial)
          .build();
        this.#send(frame('p', body));
        return;
      }
      case 11: {
        // SASLContinue
        const serverFirst = reader.bytes(reader.remaining).toString('utf8');
        const final = Buffer.from(this.scram.finalResponse(serverFirst), 'utf8');
        this.#send(frame('p', final));
        return;
      }
      case 12: {
        // SASLFinal
        this.scram.verifyFinal(reader.bytes(reader.remaining).toString('utf8'));
        return;
      }
      default:
        throw new Error(`Unsupported Postgres authentication request: ${code}`);
    }
  }

  // -- queries --------------------------------------------------------------
  /** Simple query protocol: allows multi-statement scripts, no parameters. */
  exec(sql) {
    return this.#enqueue(frame('Q', new Writer().cstring(sql).build()));
  }

  /** Extended query protocol with bound parameters. */
  query(sql, params = []) {
    // Parse: unnamed statement, with every parameter type left unspecified (0)
    // so the server infers it from context.
    const parseWriter = new Writer().cstring('').cstring(sql).int16(params.length);
    for (let i = 0; i < params.length; i += 1) parseWriter.int32(0);
    const parse = frame('P', parseWriter.build());

    const bindWriter = new Writer()
      .cstring('') // portal
      .cstring('') // statement
      .int16(0); // all parameters in text format
    bindWriter.int16(params.length);
    for (const param of params) {
      const encoded = encodeParam(param);
      if (encoded === null) {
        bindWriter.int32(-1);
      } else {
        const buf = Buffer.from(encoded, 'utf8');
        bindWriter.int32(buf.length).bytes(buf);
      }
    }
    bindWriter.int16(0); // all results in text format

    const payload = Buffer.concat([
      parse,
      frame('B', bindWriter.build()),
      // Without an explicit Describe the server sends DataRow messages with no
      // preceding RowDescription, leaving the client unable to name columns.
      frame('D', new Writer().int8(0x50 /* 'P' portal */).cstring('').build()),
      frame('E', new Writer().cstring('').int32(0).build()),
      frame('S', Buffer.alloc(0)),
    ]);
    return this.#enqueue(payload);
  }

  async end() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.#send(frame('X', Buffer.alloc(0)));
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.end();
      setTimeout(resolve, 250).unref?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------
export class PgPool {
  constructor(options) {
    this.options = options;
    this.max = options.max || 6;
    this.idle = [];
    this.size = 0;
    this.waiters = [];
    this.ending = false;
  }

  async #create() {
    const conn = new PgConnection(this.options);
    conn.on('error', () => {});
    await conn.connect();
    this.size += 1;
    conn.once('close', () => {
      this.size -= 1;
      this.idle = this.idle.filter((c) => c !== conn);
    });
    return conn;
  }

  async acquire() {
    if (this.ending) throw new Error('Pool is shutting down');
    while (this.idle.length) {
      const conn = this.idle.pop();
      if (!conn.closed && conn.socket && !conn.socket.destroyed) return conn;
    }
    if (this.size < this.max) return this.#create();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  release(conn) {
    if (conn.closed || !conn.socket || conn.socket.destroyed) {
      const waiter = this.waiters.shift();
      if (waiter) this.#create().then(waiter.resolve, waiter.reject);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(conn);
    else this.idle.push(conn);
  }

  async query(sql, params) {
    const conn = await this.acquire();
    try {
      return params && params.length ? await conn.query(sql, params) : await conn.query(sql, []);
    } finally {
      this.release(conn);
    }
  }

  async exec(sql) {
    const conn = await this.acquire();
    try {
      return await conn.exec(sql);
    } finally {
      this.release(conn);
    }
  }

  async end() {
    this.ending = true;
    const all = [...this.idle];
    this.idle = [];
    await Promise.all(all.map((c) => c.end()));
  }
}

/** Parse a libpq-style connection URL. */
export function parseConnectionUrl(url) {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  return {
    host: decodeURIComponent(parsed.hostname || '127.0.0.1'),
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database: decodeURIComponent((parsed.pathname || '').replace(/^\//, '')) || 'postgres',
    ssl: sslmode ? !['disable', 'allow', 'prefer'].includes(sslmode) : false,
    sslRejectUnauthorized: sslmode !== 'require' && sslmode !== 'no-verify',
  };
}
