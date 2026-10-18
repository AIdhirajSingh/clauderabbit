/**
 * Shell commands that print the installed static scanner versions inside the
 * template. Shared by the template build (sandbox/e2b/template.ts asserts them
 * against the pins) and the operator smoke route (lib/server/ops-smoke.ts prints
 * them from a live VM). GuardDog and yara-x are read from package metadata
 * because neither has a stable `--version` flag.
 */

export const SEMGREP_VERSION_CMD = "/opt/cr/tools/bin/semgrep --version";
export const GUARDDOG_VERSION_CMD =
  "/opt/cr/tools/uv/guarddog/bin/python -c 'import importlib.metadata as m; print(m.version(\"guarddog\"))'";
export const YARA_VERSION_CMD =
  "/opt/cr/venv/bin/python -c 'import importlib.metadata as m, yara_x; print(m.version(\"yara-x\"))'";
