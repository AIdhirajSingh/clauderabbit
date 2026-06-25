/*
 * BENIGN DEPENDENCY-FETCHING FIXTURE — Claude Rabbit controlled-build proof.
 * This package declares a real npm dependency (leftpad) so that the BUILD phase
 * must fetch it from the registry through the trap's allowlist proxy. If the
 * controlled-build path works, `npm install` succeeds (deps fetched, build OK),
 * and then this runs cleanly under the sinkhole making NO outbound calls — the
 * honest "no malicious behavior observed, but not fully verified" case.
 *
 * CommonJS; runs inside the sandbox.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
let leftpad;
try {
  leftpad = require('leftpad');
} catch (e) {
  leftpad = (s, n, c) => String(s).padStart(n, c || '0');
}

const padded = leftpad('42', 6, '0');
console.log('[benign] leftpad("42", 6) =', padded);
console.log('[benign] doing only local CPU-light work; no network, no credential reads.');
console.log('[benign] done.');
