/**
 * start.js — Padel 3D server launcher
 *
 * Strategy:
 *   - Always start the Node.js/Socket.io server (reliable, works everywhere)
 *   - Optionally compile & use the C++ server if CPP=1 env var is set
 *     e.g.  CPP=1 npm start
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const useCpp = process.env.CPP === '1';
const SRC    = path.join(__dirname, 'server.cpp');
const BIN    = path.join(__dirname, 'padel_server');

if (useCpp) {
  // ── C++ path ──────────────────────────────────────────
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
      console.error('[build] C++ compilation failed, falling back to Node.js.');
      require('./server_fallback.js');
      return;
    }
  } else {
    console.log('[build] C++ binary up to date.');
  }

  console.log('[run] Starting C++ padel_server...');
  const child = spawn('./padel_server', [], {
    cwd: __dirname, stdio: 'inherit', env: process.env
  });
  child.on('exit', code => { console.log(`padel_server exited: ${code}`); process.exit(code ?? 1); });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT',  () => child.kill('SIGINT'));

} else {
  // ── Node.js path (default) ────────────────────────────
  console.log('[run] Starting Node.js server...');
  require('./server_fallback.js');
}
