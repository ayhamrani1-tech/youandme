/**
 * Cross-cutting middleware: security headers, CORS, rate limiting, request
 * logging and static file serving for the built web client.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { tooMany } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), camera=(), microphone=(), payment=()',
  );
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // The client loads Google Fonts and may embed a Google Maps iframe preview.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "frame-src https://www.google.com https://maps.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  return next();
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
export function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowAll = !config.isProd && config.corsOrigins.includes('*');
  if (origin && (allowAll || config.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,Accept-Language,X-Requested-With',
  );
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return undefined;
  }
  return next();
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in-process)
// ---------------------------------------------------------------------------
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function rateLimit({ max, windowMs, keyPrefix = '' } = {}) {
  const limit = max ?? config.rateLimit.max;
  const window = windowMs ?? config.rateLimit.windowMs;
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      throw tooMany('rate_limited', 'Too many requests — please slow down.');
    }
    return next();
  };
}

/** Reset all counters (used between tests). */
export function resetRateLimits() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Request id + logging
// ---------------------------------------------------------------------------
export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  return next();
}

export function requestLogger(req, res, next) {
  if (process.env.LOG_REQUESTS === 'false') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const who = req.user ? `${req.user.role}#${req.user.id}` : 'anon';
    console.log(
      `${req.method} ${req.pathname} → ${res.statusCode} ${ms.toFixed(1)}ms [${who}]`,
    );
  });
  return next();
}

/** Negotiate the response language from the Accept-Language header. */
export function locale(req, res, next) {
  const header = String(req.headers['accept-language'] || '');
  req.locale = /^ar\b/i.test(header) || /[,\s]ar\b/i.test(header) ? 'ar' : 'en';
  return next();
}

// ---------------------------------------------------------------------------
// Static files + SPA fallback
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve `root` for non-API GET requests, falling back to index.html so client
 * side routes such as /gyms/3 survive a page refresh.
 */
export function staticFiles(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.pathname.startsWith('/api/')) return next();
    if (!fs.existsSync(root)) return next();

    const requested = path.normalize(path.join(root, decodeURIComponent(req.pathname)));
    // Reject traversal outside the served root.
    if (!requested.startsWith(path.normalize(root))) return next();

    let file = requested;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const indexFile = path.join(root, 'index.html');
      if (!fs.existsSync(indexFile)) return next();
      file = indexFile;
    }

    const ext = path.extname(file).toLowerCase();
    const stat = fs.statSync(file);
    const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return undefined;
    }
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }
    // Awaited: the framework finalises the response once the handler chain
    // unwinds, so returning before the stream has finished would truncate it.
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file);
      stream.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res).on('finish', resolve);
    });
  };
}
