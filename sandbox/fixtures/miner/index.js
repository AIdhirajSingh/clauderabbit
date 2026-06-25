/*
 * SYNTHETIC MINER FIXTURE — Claude Rabbit sandbox proof. NOT real malware.
 * Emulates a crypto-miner: pins the CPU with tight hashing-style loops across
 * worker threads and beacons to a hardcoded mining-pool host. In the sandbox
 * the CPU spike is OBSERVED and the outbound beacon is BLOCKED by the egress
 * lockdown. The whole thing is bounded by the harness ulimit + timeout, so it
 * cannot actually run unbounded — proving the resource-cap rail too.
 *
 * CommonJS Node script that runs INSIDE the sandbox (not part of the Next.js
 * module graph); `require` is deliberate, so app-code lint rules do not apply.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
const crypto = require('crypto');
const http = require('http');

// 1) Beacon to a hardcoded "mining pool" — blocked by egress lockdown.
function beacon() {
  const req = http.request(
    { hostname: 'pool.minexmr-fake.example.org', port: 80, path: '/login', method: 'GET', timeout: 4000 },
    (res) => { console.log('[miner] pool status', res.statusCode); }
  );
  req.on('error', (e) => console.log('[miner] pool unreachable (expected in sandbox):', e.code || e.message));
  req.on('timeout', () => req.destroy());
  req.end();
}

// 2) Burn CPU like a hasher. Bounded: stop after ~25s wall so the fixture is
//    self-terminating even before the harness timeout — but long enough for the
//    observer to register sustained high CPU.
function mine(deadline) {
  let h = Buffer.from('seed');
  let n = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 50000; i++) {
      h = crypto.createHash('sha256').update(h).digest();
      n++;
    }
  }
  console.log('[miner] hashed', n, 'times');
}

beacon();
const stop = Date.now() + 25000;
// spawn a couple of busy loops to look like multi-worker mining
mine(stop);
beacon();
console.log('[miner] done');
