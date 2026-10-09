#!/usr/bin/env node
/**
 * Build the web client: esbuild for the React bundle, the Tailwind compiler API
 * for the stylesheet.
 *
 *   node build.mjs            production build into dist/
 *   node build.mjs --watch    rebuild on change and serve with live reload
 *
 * Tailwind v4 is driven through its programmatic `compile()` API rather than a
 * CLI, so the only build dependencies are esbuild and tailwindcss itself.
 */
import esbuild from 'esbuild';
import { compile } from 'tailwindcss';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = import.meta.dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');
const PORT = Number(process.env.WEB_PORT || 5173);
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:4000';

/** Resolve the installed tailwindcss package directory. */
const TAILWIND_DIR = path.dirname(require.resolve('tailwindcss/package.json'));

// ---------------------------------------------------------------------------
// Tailwind
// ---------------------------------------------------------------------------
async function loadStylesheet(id, base) {
  let file;
  if (id === 'tailwindcss') file = path.join(TAILWIND_DIR, 'index.css');
  else if (id.startsWith('tailwindcss/')) file = path.join(TAILWIND_DIR, id.slice('tailwindcss/'.length));
  else file = path.resolve(base, id);
  if (!path.extname(file)) file += '.css';
  return { content: await fs.readFile(file, 'utf8'), base: path.dirname(file), path: file };
}

async function sourceFiles(dir = SRC, found = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, found);
    else if (/\.(jsx?|html)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Collect class-name candidates from source text.
 *
 * Tailwind's native scanner is a Rust binary that is not available here, so
 * candidates are harvested from string literals. Unknown candidates are ignored
 * by the compiler, so over-collecting is harmless; the components therefore use
 * only literal class names (never interpolated ones), which is the recommended
 * practice regardless of scanner.
 */
function extractCandidates(text, into) {
  const strings = text.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
  for (const literal of strings) {
    for (const token of literal.slice(1, -1).split(/[\s"'`]+/)) {
      const candidate = token.trim();
      if (!candidate || candidate.length > 60) continue;
      if (!/^[-a-zA-Z0-9:[\]()./%#,_*+!<>=$'"@]+$/.test(candidate)) continue;
      if (!/[a-zA-Z]/.test(candidate)) continue;
      into.add(candidate);
    }
  }
}

async function buildCss() {
  const files = await sourceFiles();
  files.push(path.join(ROOT, 'index.html'));
  const candidates = new Set();
  for (const file of files) {
    extractCandidates(await fs.readFile(file, 'utf8'), candidates);
  }
  const entry = await fs.readFile(path.join(SRC, 'styles.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SRC,
    loadStylesheet,
    async loadModule() {
      throw new Error('JavaScript Tailwind plugins are not used in this project');
    },
    onDependency() {},
  });
  const css = compiler.build([...candidates]);
  await fs.writeFile(path.join(DIST, 'app.css'), css, 'utf8');
  return { bytes: css.length, candidates: candidates.size };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
async function buildHtml() {
  const template = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const html = WATCH
    ? template.replace('</body>', `  <script src="/__reload.js"></script>\n</body>`)
    : template;
  await fs.writeFile(path.join(DIST, 'index.html'), html, 'utf8');
}

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------
const esbuildOptions = {
  entryPoints: [path.join(SRC, 'main.jsx')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  outfile: path.join(DIST, 'app.js'),
  minify: !WATCH,
  sourcemap: WATCH ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(WATCH ? 'development' : 'production'),
    __API_BASE__: JSON.stringify(process.env.API_BASE || ''),
  },
  logLevel: 'info',
  loader: { '.svg': 'text' },
};

// ---------------------------------------------------------------------------
// Dev server: static files, API proxy, live reload
// ---------------------------------------------------------------------------
const clients = new Set();

function startDevServer() {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/__reload.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(
        `new EventSource('/__reload').onmessage = () => location.reload();`,
      );
      return;
    }

    // Everything under /api is proxied to the running API server.
    if (url.pathname.startsWith('/api')) {
      const target = new URL(API_TARGET);
      const proxied = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxied.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'api_unreachable', message: `Cannot reach ${API_TARGET}: ${err.message}` },
          }),
        );
      });
      req.pipe(proxied);
      return;
    }

    let file = path.join(DIST, url.pathname);
    if (!fssync.existsSync(file) || fssync.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fssync.createReadStream(file).pipe(res);
  });

  server.listen(PORT, () => {
    console.log(`\n  web      http://localhost:${PORT}`);
    console.log(`  api      proxied to ${API_TARGET}\n`);
  });
}

function notifyReload() {
  for (const client of clients) client.write('data: reload\n\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
await fs.mkdir(DIST, { recursive: true });
const publicDir = path.join(ROOT, 'public');
if (fssync.existsSync(publicDir)) {
  await fs.cp(publicDir, DIST, { recursive: true });
}
await buildHtml();

if (WATCH) {
  const context = await esbuild.context({
    ...esbuildOptions,
    plugins: [
      {
        name: 'tailwind-and-reload',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            const css = await buildCss();
            console.log(`  css      ${(css.bytes / 1024).toFixed(1)} kB`);
            notifyReload();
          });
        },
      },
    ],
  });
  await context.watch();
  startDevServer();
} else {
  await esbuild.build(esbuildOptions);
  const css = await buildCss();
  const js = await fs.stat(path.join(DIST, 'app.js'));
  console.log(`\n  dist/app.js    ${(js.size / 1024).toFixed(1)} kB`);
  console.log(`  dist/app.css   ${(css.bytes / 1024).toFixed(1)} kB  (${css.candidates} candidates scanned)\n`);
}
