/**
 * start.js  —  Build + launch the C++ padel server
 *
 * Render runs:  npm start  →  node start.js
 * This script:
 *   1. Compiles server.cpp  (only if binary is missing / stale)
 *   2. Spawns ./padel_server, forwarding PORT env and all stdio
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'server.cpp');
const BIN = path.join(__dirname, 'padel_server');

// ── Compile ───────────────────────────────────────────────
const needsBuild = !fs.existsSync(BIN) ||
  fs.statSync(SRC).mtimeMs > fs.statSync(BIN).mtimeMs;

if (needsBuild) {
  console.log('[build] Compiling C++ server...');
  try {
    execSync(
      'g++ -std=c++20 -O2 -o padel_server server.cpp ' +
      '-lboost_system -lssl -lcrypto -lpthread',
      { stdio: 'inherit', cwd: __dirname }
    );
    console.log('[build] Compilation successful.');
  } catch (e) {
    console.error('[build] Compilation FAILED — falling back to Node.js server.');
    // Fall back to the JS server if C++ fails (e.g. missing libs on some hosts)
    require('./server_fallback.js');
    return;
  }
} else {
  console.log('[build] Binary up to date, skipping compilation.');
}

// ── Launch ────────────────────────────────────────────────
console.log('[run] Starting padel_server...');
const child = spawn('./padel_server', [], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  console.log(`[run] padel_server exited with code ${code}`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT',  () => child.kill('SIGINT'));
