#!/usr/bin/env node
/**
 * Run the API and the web client together, with one prefixed log stream.
 *
 *   npm run dev
 *
 * Replaces a `concurrently` dependency with about forty lines.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COLOURS = { api: '\u001b[36m', web: '\u001b[35m', reset: '\u001b[0m' };

const children = [];

function run(name, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd: path.join(ROOT, cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const prefix = `${COLOURS[name]}${name.padEnd(3)}${COLOURS.reset} │ `;
  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stdout.write(`${prefix}exited with code ${code}\n`);
    }
    shutdown();
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('api', 'server', ['--watch', 'src/index.js']);
run('web', 'web', ['build.mjs', '--watch']);
