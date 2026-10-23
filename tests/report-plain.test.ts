import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicPhrase, plainEvidence, plainJev, plainLine } from "../components/v4/report/plain.ts";

test("heuristic evidence becomes plain words plus the file:line", () => {
  assert.deepEqual(plainEvidence("-5: heuristic heur.shell_fetch.unrecognized at utils/releasetools/02_upload_tarball.sh:16 (import)"), {
    text: "A shell script downloads and runs code from an unrecognised source",
    where: "utils/releasetools/02_upload_tarball.sh:16",
  });
});

test("Jev evidence drops the points and the probability", () => {
  assert.deepEqual(plainEvidence("-8: Jev flagged check: malicious at install.js:10 (install, p=0.92)"), {
    text: "Jev judged this code malicious",
    where: "install.js:10",
  });
});

test("an unknown heuristic id never reaches the page", () => {
  const r = plainEvidence("-3: heuristic heur.brand_new.rule at a/b.js:2 (install)");
  assert.equal(r.text, "A code pattern the scanners flag");
  assert.equal(r.where, "a/b.js:2");
  assert.equal(heuristicPhrase("heur.nope"), "A code pattern the scanners flag");
  assert.ok(!plainLine("found heur.weird.thing here").includes("heur."));
});

test("plain text passes through without its point prefix", () => {
  assert.deepEqual(plainEvidence("-10: Partial scan: no program to run"), { text: "Partial scan: no program to run", where: null });
  assert.equal(plainLine("Partial scan: Build finished, so the score is capped at 80."), "Partial scan: Build finished, so the score is capped at 80.");
});

test("every known heuristic has a phrase without an id in it", () => {
  for (const id of ["heur.cred.ssh_key", "heur.install_hook", "heur.typosquat", "heur.obfuscation.hex_escapes"]) {
    const p = heuristicPhrase(id);
    assert.notEqual(p, "A code pattern the scanners flag");
    assert.ok(!/heur\.|_/.test(p));
  }
});

test("Jev transcripts read as plain sentences with no key=value or p=", () => {
  const lines = plainJev(
    "Jev install check: install surface install_network=true p=0.56; install surface install_credentials=false p=0.38; lib/x.js malicious p=0.91",
  );
  assert.deepEqual(lines, [
    { text: "Install-time code uses the network", where: null },
    { text: "Install-time code does not read credentials", where: null },
    { text: "Jev judged this code malicious", where: "lib/x.js" },
  ]);
  const docs = plainJev("Jev docs check: documentation declares_no_network=false p=0.05; documentation versus measured capabilities consistent p=0.99");
  assert.deepEqual(docs.map((d) => d.text), ["The docs do not say it makes no network calls", "What it did fits what its docs say it is for"]);
  for (const l of [...lines, ...docs]) assert.ok(!/=|p=|_/.test(l.text));
});
