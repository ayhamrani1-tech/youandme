/**
 * A small HTTP framework over `node:http`.
 *
 * Provides what this API needs from Express and nothing more: a middleware
 * chain, `:param` route matching, mountable sub-routers, JSON body parsing with
 * a size limit, response helpers and centralised error handling.
 */
import http from 'node:http';
import { HttpError, translateDbError, notFound } from './errors.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Compile '/businesses/:id/staff/:staffId' into a matcher. */
function compilePath(pattern) {
  const names = [];
  const source = pattern
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '/([^/]+)';
      }
      if (segment === '*') {
        names.push('wildcard');
        return '/?(.*)';
      }
      return segment ? `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : '';
    })
    .join('');
  return { regex: new RegExp(`^${source || '/'}/?$`), names };
}

export class Router {
  constructor() {
    this.stack = [];
  }

  /** Register middleware, or mount a sub-router at a prefix. */
  use(prefixOrHandler, maybeRouter) {
    if (typeof prefixOrHandler === 'function') {
      this.stack.push({ kind: 'middleware', handler: prefixOrHandler });
      return this;
    }
    this.stack.push({ kind: 'mount', prefix: prefixOrHandler.replace(/\/+$/, ''), router: maybeRouter });
    return this;
  }

  route(method, pattern, ...handlers) {
    this.stack.push({ kind: 'route', method, ...compilePath(pattern), pattern, handlers });
    return this;
  }

  /** Collect every matching handler for a request path. */
  resolve(method, pathname, basePath = '') {
    const chain = [];
    let matched = false;
    let allowed = new Set();

    for (const entry of this.stack) {
      if (entry.kind === 'middleware') {
        chain.push(entry.handler);
        continue;
      }
      if (entry.kind === 'mount') {
        if (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) {
          const rest = pathname.slice(entry.prefix.length) || '/';
          const inner = entry.router.resolve(method, rest, basePath + entry.prefix);
          chain.push(...inner.chain);
          inner.allowed.forEach((m) => allowed.add(m));
          if (inner.matched) return { chain, matched: true, params: inner.params, allowed };
        }
        continue;
      }
      const match = entry.regex.exec(pathname);
      if (!match) continue;
      allowed.add(entry.method);
      if (entry.method !== method) continue;
      const params = {};
      entry.names.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? '');
      });
      chain.push(...entry.handlers);
      matched = true;
      return { chain, matched, params, allowed };
    }
    return { chain, matched, params: {}, allowed };
  }
}

for (const method of METHODS) {
  Router.prototype[method.toLowerCase()] = function (pattern, ...handlers) {
    return this.route(method, pattern, ...handlers);
  };
}

// ---------------------------------------------------------------------------
// Request / response decoration
// ---------------------------------------------------------------------------
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Request body exceeds 1 MB.');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

function decorateResponse(res) {
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (payload, code) {
    if (code) this.statusCode = code;
    const body = JSON.stringify(payload ?? null);
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.setHeader('Content-Length', Buffer.byteLength(body));
    this.end(body);
    return this;
  };
  res.text = function (body, code) {
    if (code) this.statusCode = code;
    this.setHeader('Content-Type', 'text/plain; charset=utf-8');
    this.end(body);
    return this;
  };
  res.noContent = function () {
    this.statusCode = 204;
    this.end();
    return this;
  };
  return res;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
export class App extends Router {
  constructor({ onError, notFoundHandler } = {}) {
    super();
    this.onError = onError;
    this.notFoundHandler = notFoundHandler;
  }

  handler() {
    return async (req, res) => {
      decorateResponse(res);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      req.pathname = url.pathname;
      req.query = Object.fromEntries(url.searchParams.entries());
      req.searchParams = url.searchParams;
      req.ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        '';

      try {
        req.body = await readBody(req);
        const { chain, matched, params, allowed } = this.resolve(req.method, req.pathname);
        req.params = params;

        if (!matched && req.method === 'OPTIONS' && allowed.size) {
          res.setHeader('Allow', [...allowed, 'OPTIONS'].join(', '));
          return res.noContent();
        }

        let index = 0;
        const next = async () => {
          if (index < chain.length) {
            const handler = chain[index++];
            const result = await handler(req, res, next);
            // Handlers may simply return their payload; the framework writes it.
            if (result !== undefined && !res.writableEnded) res.json(result);
            return result;
          }
          if (!matched) {
            if (this.notFoundHandler) return this.notFoundHandler(req, res);
            throw notFound('route_not_found', `No route for ${req.method} ${req.pathname}`);
          }
          return undefined;
        };
        await next();
        if (!res.writableEnded) {
          // A matched handler that wrote nothing at all: treat as 204.
          res.noContent();
        }
      } catch (err) {
        await this.#handleError(err, req, res);
      }
    };
  }

  async #handleError(err, req, res) {
    const translated = err instanceof HttpError ? err : translateDbError(err) || err;
    const status = translated.status || 500;
    if (this.onError) this.onError(translated, req, status);
    if (res.writableEnded) return;
    const payload = {
      error: {
        code: translated.code || (status === 500 ? 'internal_error' : 'error'),
        message:
          status === 500 && process.env.NODE_ENV === 'production'
            ? 'Something went wrong.'
            : translated.message || 'Something went wrong.',
      },
    };
    if (translated.details) payload.error.details = translated.details;
    res.json(payload, status);
  }

  listen(port, host) {
    const server = http.createServer(this.handler());
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  }
}
