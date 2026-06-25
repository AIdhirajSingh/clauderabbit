// SYNTHETIC FIXTURE entrypoint. Harmless on its own; the malice is in the
// postinstall hook (scripts/postinstall.js), which is the install-time surface.
console.log('totally-legit-utils loaded');
module.exports = { ok: true };
