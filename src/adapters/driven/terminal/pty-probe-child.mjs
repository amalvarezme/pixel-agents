#!/usr/bin/env node
// Short-lived child process for the node-pty capability probe (design.md D5, tasks.md 4.1).
//
// Runs OUT OF PROCESS deliberately: a native segfault inside node-pty cannot be caught with
// try/catch, so the parent (node-pty-probe.ts) never runs this logic itself — it only reads
// this script's exit code/signal and stdout. A crash here becomes a readable failure there,
// never a crash of the visualizer process.
//
// Opens a 1x1 pty against /usr/bin/true, cross-checks process.arch and the spawn-helper exec
// bit, and always prints exactly one JSON line before exiting 0 on a CAUGHT failure. An
// uncaught native crash still surfaces to the parent as a non-zero exit code or a termination
// signal, which is exactly the signal the probe is built to read.
//
// This module is plain ESM (no TypeScript build step) so it can be spawned directly with
// `node <this file>` without a transpiler in the path.

import { access, constants as fsConstants } from 'node:fs/promises';
import { createRequire } from 'node:module';

function report(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

async function main() {
  let pty;
  try {
    const require = createRequire(import.meta.url);
    pty = require('node-pty');
  } catch (err) {
    report({ available: false, reason: `node-pty not installed: ${err.message} (arch=${process.arch})` });
    return;
  }

  const spawnHelperPath = pty.spawnHelperPath ?? null;
  if (spawnHelperPath) {
    try {
      await access(spawnHelperPath, fsConstants.X_OK);
    } catch {
      report({ available: false, reason: `spawn-helper not executable at ${spawnHelperPath}` });
      return;
    }
  }

  try {
    const term = pty.spawn('/usr/bin/true', [], { name: 'xterm-color', cols: 1, rows: 1 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pty did not exit in time')), 3000);
      term.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    report({ available: true });
  } catch (err) {
    report({ available: false, reason: `pty spawn failed: ${err.message} (arch=${process.arch})` });
  }
}

main();
