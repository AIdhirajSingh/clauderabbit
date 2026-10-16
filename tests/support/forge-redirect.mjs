/**
 * Test-only preload (node --import) that stands in for the VM's nftables inner
 * fence when the mock sandbox runs OUR fixture locally: every DNS lookup goes
 * to the test forge's DNS port (which records it), and every TCP connection to
 * a non-loopback host is redirected to the test forge's HTTPS port, keeping the
 * original host for SNI and certificate checks. It is loaded only into the
 * fixture's processes by tests/support/mock-sandbox.ts.
 */

import dns from "node:dns";
import net from "node:net";

const forgePort = Number(process.env.CR_TEST_FORGE_PORT);
const dnsPort = Number(process.env.CR_TEST_DNS_PORT);
if (!forgePort || !dnsPort) throw new Error("forge-redirect: CR_TEST_FORGE_PORT and CR_TEST_DNS_PORT are required");

const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
resolver.setServers([`127.0.0.1:${dnsPort}`]);

function forgeLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  resolver.resolve4(hostname, (err) => {
    if (err) return callback(err);
    // Like the nftables redirect: whatever the answer, the connection lands on the forge.
    if (options && options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first && typeof first === "object" ? first : null;
  if (opts && typeof opts === "object" && !opts.path) {
    const host = opts.host ?? "localhost";
    if (!LOOPBACK.has(host)) {
      if (net.isIP(host)) opts.host = "127.0.0.1";
      opts.port = forgePort;
      opts.lookup = forgeLookup;
      opts.family = 4;
      opts.autoSelectFamily = false;
    }
  }
  return original.apply(this, args);
};
