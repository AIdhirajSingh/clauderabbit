#!/usr/bin/env python3
"""
knowledge_graph.py — the exploration map for the agentic sandbox brain.

Phase 2, component 1 (AGENTIC-DESIGN.md). Pure Python 3, stdlib only. It runs
on the controller over the OFF-VM clone, BEFORE any detonation, and NEVER
executes target code. It builds a structural map of the whole repo so the agent
can JUMP to suspicious nodes instead of reading the tree linearly — finding the
dangerous code the stage-1 flagged-region scan never looked at.

What it produces (`build_graph(repo_dir) -> dict`, also written as
`knowledge-graph.json`):
  - summary       : counts, languages, truncation notes
  - files         : per-file index (path, language, size, lines, flags)
  - edges         : import/require/include dependency edges (best-effort)
  - manifests     : parsed package.json / requirements / go.mod / Cargo / setup
  - install_scripts: install/build surfaces (shell, postinstall, Makefile, ...)
  - hotspots      : files ranked by suspicion (REAL static signals + structure)

Suspicion is derived from the EXISTING static scanner (scan_files.ts, which
imports the one true `staticScan` — audit rule M3: do not fork the patterns)
plus structural hints (install scripts, entry points, deep/obscure paths). If
`deno` is unavailable, the graph still builds (structure-only ranking) and says
so — it degrades, it never crashes.

Safety: repo bytes are DATA, never instructions. Nothing here evals/execs repo
content. File sizes are capped, manifests are parsed in try/except, symlinks are
not followed out of the repo, and array outputs are bounded.

Usage:
  python knowledge_graph.py <repo_dir> [--out knowledge-graph.json]
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# --- Bounds (named constants, no magic numbers) ------------------------------

MAX_FILE_BYTES = 256 * 1024          # cap content read per file
MAX_SCAN_BYTES_FOR_IMPORTS = 256 * 1024
MAX_FILES_IN_OUTPUT = 5000           # bound the files array
MAX_EDGES_IN_OUTPUT = 5000           # bound the edges array
MAX_HOTSPOTS = 200                   # bound the hotspots array
MAX_SCAN_BATCH = 200                 # files per deno subprocess call
DENO_TIMEOUT_S = 120                 # subprocess hard timeout
BINARY_PROBE_BYTES = 8000            # bytes to sniff for NUL (binary tell)

# Directories whose CONTENTS are noise: we RECORD that they exist (one marker
# node) but do not index every file inside. Keeps the graph about the repo's own
# code, not its vendored/build output.
NOISE_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "vendor",
    ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv",
    "target", ".gradle", ".idea", ".vscode", "bower_components",
    ".pytest_cache", ".mypy_cache", "site-packages",
}

# Files whose BODY is noise (minified / lockfile) — recorded, body not scanned.
LOCKFILE_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
    "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "composer.lock",
    "Gemfile.lock",
}

MINIFIED_RE = re.compile(r"\.(min\.js|min\.css)$", re.IGNORECASE)

# Extension -> language label.
EXT_LANG = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".py": "python", ".pyw": "python", ".go": "go", ".rs": "rust",
    ".rb": "ruby", ".php": "php", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".sh": "shell", ".bash": "shell", ".ps1": "powershell",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
    ".md": "markdown", ".html": "html", ".css": "css", ".sql": "sql",
}

# Source extensions we hand to the static scanner (text code only).
SCANNABLE_EXT = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".pyw",
    ".go", ".rs", ".rb", ".php", ".java", ".kt", ".sh", ".bash",
    ".ps1", ".json", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
}

# Entry-point basenames (more likely to matter / be detonated).
ENTRY_BASENAMES = {
    "index.js", "index.ts", "index.mjs", "main.js", "main.ts", "main.py",
    "__main__.py", "app.js", "app.py", "server.js", "main.go", "main.rs",
    "cli.js", "cli.py", "setup.py",
}

# Install/build surfaces — prime suspicion sources.
INSTALL_SCRIPT_BASENAMES = {
    "setup.py", "makefile", "dockerfile", "postinstall.js", "preinstall.js",
    "install.js", "install.sh", "setup.sh", "bootstrap.sh", "build.sh",
}

# --- Import extraction patterns (best-effort, per language) ------------------

IMPORT_PATTERNS = {
    "javascript": [
        re.compile(r"""\bimport\s+(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]"""),
        re.compile(r"""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
        re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
    ],
    "typescript": [
        re.compile(r"""\bimport\s+(?:type\s+)?(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]"""),
        re.compile(r"""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
        re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
        re.compile(r"""\bexport\s+(?:[\w*\s{},]+\s+)?from\s+['"]([^'"]+)['"]"""),
    ],
    "python": [
        re.compile(r"""^\s*import\s+([a-zA-Z0-9_.]+)""", re.MULTILINE),
        re.compile(r"""^\s*from\s+([a-zA-Z0-9_.]+)\s+import""", re.MULTILINE),
    ],
    "go": [
        re.compile(r"""\bimport\s+"([^"]+)"\b"""),
        re.compile(r"""\bimport\s*\(([^)]*)\)""", re.DOTALL),
    ],
    "rust": [
        re.compile(r"""^\s*use\s+([a-zA-Z0-9_:]+)""", re.MULTILINE),
    ],
    "ruby": [
        re.compile(r"""\brequire(?:_relative)?\s+['"]([^'"]+)['"]"""),
    ],
    "php": [
        re.compile(r"""\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]"""),
    ],
    "c": [re.compile(r"""^\s*#\s*include\s*[<"]([^>"]+)[>"]""", re.MULTILINE)],
    "cpp": [re.compile(r"""^\s*#\s*include\s*[<"]([^>"]+)[>"]""", re.MULTILINE)],
    "java": [re.compile(r"""^\s*import\s+([a-zA-Z0-9_.]+)\s*;""", re.MULTILINE)],
    "kotlin": [re.compile(r"""^\s*import\s+([a-zA-Z0-9_.]+)""", re.MULTILINE)],
    "shell": [re.compile(r"""(?:^|\s)(?:source|\.)\s+(\S+)""", re.MULTILINE)],
}

JS_TS_EXT_CANDIDATES = [
    "", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    "/index.js", "/index.ts", "/index.jsx", "/index.tsx",
]


# --- Filesystem helpers ------------------------------------------------------

def _is_noise_dir(name: str) -> bool:
    return name in NOISE_DIRS


def _language_for(path: Path) -> str:
    return EXT_LANG.get(path.suffix.lower(), "other")


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:BINARY_PROBE_BYTES]


def _read_text_capped(path: Path) -> tuple[str | None, bool]:
    """Read up to MAX_FILE_BYTES as text. Returns (text|None, truncated).
    None means unreadable/binary — never raises."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None, False
    truncated = len(raw) > MAX_FILE_BYTES
    if truncated:
        raw = raw[:MAX_FILE_BYTES]
    if _looks_binary(raw):
        return None, truncated
    return raw.decode("utf-8", errors="replace"), truncated


def _rel(path: Path, root: Path) -> str:
    """Repo-relative POSIX path (stable across Windows/Unix)."""
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _walk_repo(root: Path):
    """Yield (file_path, is_noise_dir_marker). Skips noise-dir contents but
    yields a single marker per top-level noise dir. Never follows symlinked
    dirs out of the tree."""
    noise_seen: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dp = Path(dirpath)
        # Prune noise dirs from traversal but remember they existed.
        kept = []
        for d in dirnames:
            if _is_noise_dir(d):
                marker = _rel(dp / d, root)
                if marker not in noise_seen:
                    noise_seen.add(marker)
                    yield (dp / d, True)
            else:
                kept.append(d)
        dirnames[:] = kept
        for fn in filenames:
            fp = dp / fn
            # Skip symlinked files (could point outside the repo).
            try:
                if fp.is_symlink():
                    continue
            except OSError:
                continue
            yield (fp, False)


# --- Manifest parsing (all try/except — never trust the bytes) ---------------

def _parse_package_json(text: str) -> dict:
    out = {"type": "package.json", "deps": [], "scripts": {}, "install_scripts": []}
    try:
        pkg = json.loads(text)
    except (ValueError, TypeError):
        out["error"] = "unparseable package.json"
        return out
    if not isinstance(pkg, dict):
        out["error"] = "package.json is not an object"
        return out
    out["name"] = pkg.get("name") if isinstance(pkg.get("name"), str) else None
    for key in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        block = pkg.get(key)
        if isinstance(block, dict):
            out["deps"].extend(sorted(str(k) for k in block.keys()))
    scripts = pkg.get("scripts")
    if isinstance(scripts, dict):
        out["scripts"] = {str(k): str(v) for k, v in scripts.items()}
        for hook in ("preinstall", "install", "postinstall", "prepare", "prepublish"):
            if hook in out["scripts"]:
                out["install_scripts"].append(hook)
    return out


def _parse_requirements_txt(text: str) -> dict:
    deps = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("-"):
            continue
        name = re.split(r"[<>=!~;\[ ]", s, 1)[0].strip()
        if name:
            deps.append(name)
    return {"type": "requirements.txt", "deps": sorted(set(deps))}


def _parse_setup_py(text: str) -> dict:
    out = {"type": "setup.py", "deps": [], "install_scripts": ["setup.py"]}
    m = re.search(r"install_requires\s*=\s*\[([^\]]*)\]", text, re.DOTALL)
    if m:
        out["deps"] = sorted(set(re.findall(r"""['"]([A-Za-z0-9_.\-]+)""", m.group(1))))
    return out


def _parse_go_mod(text: str) -> dict:
    deps = []
    for m in re.finditer(r"^\s*require\s+([^\s]+)\s+v", text, re.MULTILINE):
        deps.append(m.group(1))
    block = re.search(r"require\s*\(([^)]*)\)", text, re.DOTALL)
    if block:
        for line in block.group(1).splitlines():
            tok = line.strip().split()
            if tok and not tok[0].startswith("//"):
                deps.append(tok[0])
    return {"type": "go.mod", "deps": sorted(set(deps))}


def _parse_cargo_toml(text: str) -> dict:
    deps = []
    in_deps = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("["):
            in_deps = "dependencies" in s
            continue
        if in_deps and "=" in s and not s.startswith("#"):
            deps.append(s.split("=", 1)[0].strip())
    return {"type": "Cargo.toml", "deps": sorted(set(d for d in deps if d))}


MANIFEST_PARSERS = {
    "package.json": _parse_package_json,
    "requirements.txt": _parse_requirements_txt,
    "setup.py": _parse_setup_py,
    "go.mod": _parse_go_mod,
    "Cargo.toml": _parse_cargo_toml,
}


# --- Import extraction + resolution ------------------------------------------

def _extract_imports(language: str, text: str) -> list[str]:
    pats = IMPORT_PATTERNS.get(language)
    if not pats:
        return []
    found: list[str] = []
    body = text[:MAX_SCAN_BYTES_FOR_IMPORTS]
    for pat in pats:
        for m in pat.finditer(body):
            spec = m.group(1).strip()
            if not spec:
                continue
            # The go import-block group may capture many quoted strings.
            if language == "go" and '"' in spec:
                found.extend(re.findall(r'"([^"]+)"', spec))
            else:
                found.append(spec)
    # De-dup, preserve order.
    seen: set[str] = set()
    out = []
    for s in found:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _resolve_relative(importer_rel: str, spec: str, rel_set: set[str]) -> str | None:
    """Resolve a relative JS/TS import to a repo file, best-effort."""
    base = (Path(importer_rel).parent / spec).as_posix()
    base = os.path.normpath(base).replace(os.sep, "/")
    if base.startswith("../"):
        return None
    for cand in JS_TS_EXT_CANDIDATES:
        target = os.path.normpath(base + cand).replace(os.sep, "/")
        if target in rel_set:
            return target
    return None


def _build_edges(file_records: list[dict], rel_set: set[str]) -> list[dict]:
    edges: list[dict] = []
    for rec in file_records:
        importer = rec["path"]
        for spec in rec.get("_imports", []):
            resolved = None
            if spec.startswith("."):
                resolved = _resolve_relative(importer, spec, rel_set)
            if resolved:
                edges.append({"from": importer, "to": resolved, "spec": spec, "kind": "internal"})
            else:
                edges.append({"from": importer, "to": None, "spec": spec, "kind": "external"})
    return edges


# --- Suspicion ranking -------------------------------------------------------

# Weights for static signals (from the real scanner) and structural hints.
SIGNAL_WEIGHTS = {
    "obfuscation": 45,
    "credAccess": 40,
    "embeddedSecret": 38,
    "installHook": 20,
    "network": 15,
    "typosquat": 12,
}
SEVERITY_WEIGHTS = {"high": 30, "medium": 15, "low": 6, "clean": 0}
STRUCT_INSTALL_SCRIPT = 18
STRUCT_INSTALL_NET = 14
STRUCT_ENTRY_POINT = 6
STRUCT_DEEP_PATH = 5      # buried 3+ dirs deep
STRUCT_OBSCURE_NAME = 4   # short/random-ish basename
DEEP_PATH_THRESHOLD = 3


def _run_static_scan(repo_dir: Path, scan_paths: list[str]) -> tuple[dict, str | None]:
    """Invoke scan_files.ts over the given paths. Returns (perFile-by-relpath,
    error|None). Degrades gracefully if deno is missing/fails."""
    if not scan_paths:
        return {}, None
    cli = Path(__file__).resolve().parent / "scan_files.ts"
    if not cli.exists():
        return {}, "scan_files.ts not found"
    per_file_by_rel: dict[str, dict] = {}
    last_err: str | None = None
    for i in range(0, len(scan_paths), MAX_SCAN_BATCH):
        batch = scan_paths[i:i + MAX_SCAN_BATCH]
        abs_batch = [str((repo_dir / p)) for p in batch]
        try:
            proc = subprocess.run(
                ["deno", "run", "--allow-read", str(cli), "--stdin"],
                input="\n".join(abs_batch),
                capture_output=True,
                text=True,
                timeout=DENO_TIMEOUT_S,
                cwd=str(repo_dir),
            )
        except FileNotFoundError:
            return {}, "deno not found on PATH (structure-only ranking)"
        except subprocess.TimeoutExpired:
            last_err = "deno scan timed out"
            continue
        if proc.returncode != 0:
            last_err = f"deno exited {proc.returncode}: {proc.stderr.strip()[:200]}"
            continue
        try:
            data = json.loads(proc.stdout)
        except ValueError:
            last_err = "deno output was not JSON"
            continue
        per_file = data.get("perFile", {})
        # Keys are the abs paths we passed; map back to repo-relative.
        for abs_p, result in per_file.items():
            try:
                rel = Path(abs_p).resolve().relative_to(repo_dir.resolve()).as_posix()
            except (ValueError, OSError):
                rel = Path(abs_p).as_posix()
            per_file_by_rel[rel] = result
    return per_file_by_rel, last_err


def _obscure_name(basename: str) -> bool:
    stem = basename.rsplit(".", 1)[0]
    if len(stem) <= 2:
        return True
    # high digit ratio or hex-ish -> obscure
    if re.fullmatch(r"[0-9a-f]{6,}", stem.lower()):
        return True
    return False


def _score_file(rec: dict, scan_result: dict | None) -> tuple[int, list[str]]:
    """Combine real static signals + structural hints into a suspicion score."""
    score = 0
    reasons: list[str] = []

    if scan_result:
        signals = scan_result.get("signals", {})
        for key, weight in SIGNAL_WEIGHTS.items():
            if signals.get(key):
                score += weight
                reasons.append(f"signal:{key}")
        sev = scan_result.get("severityHint", "clean")
        score += SEVERITY_WEIGHTS.get(sev, 0)
        if sev in ("high", "medium"):
            reasons.append(f"severity:{sev}")
        if scan_result.get("installTimeNetwork"):
            score += STRUCT_INSTALL_NET
            reasons.append("install-time-network")
        n_regions = len(scan_result.get("flaggedRegions", []))
        if n_regions:
            score += min(n_regions, 5)  # small nudge, capped

    if rec.get("is_install_script"):
        score += STRUCT_INSTALL_SCRIPT
        reasons.append("install/build-script")
    if rec.get("is_entry_point"):
        score += STRUCT_ENTRY_POINT
        reasons.append("entry-point")
    if rec.get("depth", 0) >= DEEP_PATH_THRESHOLD:
        score += STRUCT_DEEP_PATH
        reasons.append("buried-deep")
    if _obscure_name(rec["basename"]):
        score += STRUCT_OBSCURE_NAME
        reasons.append("obscure-name")

    return score, reasons


# --- Main graph build --------------------------------------------------------

def build_graph(repo_dir) -> dict:
    """Build the knowledge graph for the repo at `repo_dir`. Pure analysis,
    no execution of target code. Returns the graph dict."""
    root = Path(repo_dir).resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"not a directory: {repo_dir}")

    file_records: list[dict] = []
    noise_markers: list[dict] = []
    manifests: list[dict] = []
    install_scripts: list[dict] = []
    languages: dict[str, int] = {}
    scan_paths: list[str] = []
    files_truncated = False

    for path, is_noise in _walk_repo(root):
        rel = _rel(path, root)
        if is_noise:
            noise_markers.append({"path": rel, "kind": "noise-dir", "indexed": False})
            continue

        try:
            size = path.stat().st_size
        except OSError:
            continue

        basename = path.name
        language = _language_for(path)
        depth = rel.count("/")
        is_lockfile = basename in LOCKFILE_NAMES
        is_minified = bool(MINIFIED_RE.search(basename))
        is_entry = basename in ENTRY_BASENAMES
        is_install = (
            basename.lower() in INSTALL_SCRIPT_BASENAMES
            or path.suffix.lower() in (".sh", ".bash")
            or basename.lower() == "makefile"
            or basename.lower().startswith("dockerfile")
        )

        rec = {
            "path": rel,
            "basename": basename,
            "language": language,
            "size_bytes": size,
            "line_count": 0,
            "depth": depth,
            "is_entry_point": is_entry,
            "is_install_script": is_install,
            "is_lockfile": is_lockfile,
            "is_minified": is_minified,
            "indexed": True,
            "_imports": [],
        }

        languages[language] = languages.get(language, 0) + 1

        # Body handling: lockfiles/minified are recorded but body not scanned.
        scan_body = not (is_lockfile or is_minified)
        text = None
        if scan_body:
            text, truncated = _read_text_capped(path)
            if truncated:
                files_truncated = True
                rec["truncated"] = True
            if text is None:
                rec["binary_or_unreadable"] = True
            else:
                rec["line_count"] = text.count("\n") + 1
                rec["_imports"] = _extract_imports(language, text)

        # Manifest parsing.
        parser = MANIFEST_PARSERS.get(basename)
        if parser and text is not None:
            parsed = parser(text)
            parsed["path"] = rel
            manifests.append(parsed)
            if parsed.get("install_scripts"):
                rec["has_install_hook"] = True

        if is_install:
            install_scripts.append({"path": rel, "basename": basename, "kind": "install/build-script"})

        # Hand scannable source to the real static scanner.
        if scan_body and path.suffix.lower() in SCANNABLE_EXT and text is not None:
            scan_paths.append(rel)

        file_records.append(rec)

    # Run the REAL static scanner (reuses staticScan via scan_files.ts).
    scan_by_rel, scan_error = _run_static_scan(root, scan_paths)

    # Build edges.
    rel_set = {r["path"] for r in file_records}
    edges = _build_edges(file_records, rel_set)

    # Rank hotspots.
    hotspots: list[dict] = []
    for rec in file_records:
        scan_result = scan_by_rel.get(rec["path"])
        score, reasons = _score_file(rec, scan_result)
        if score <= 0:
            continue
        sev = scan_result.get("severityHint") if scan_result else None
        hotspots.append({
            "path": rec["path"],
            "suspicion": score,
            "reasons": reasons,
            "severity_hint": sev,
            "language": rec["language"],
        })
    hotspots.sort(key=lambda h: (-h["suspicion"], h["path"]))
    hotspots = hotspots[:MAX_HOTSPOTS]

    # Strip private fields from file output + bound it.
    files_out = []
    for rec in file_records:
        clean = {k: v for k, v in rec.items() if not k.startswith("_")}
        files_out.append(clean)
    files_truncated_note = False
    if len(files_out) > MAX_FILES_IN_OUTPUT:
        files_out = files_out[:MAX_FILES_IN_OUTPUT]
        files_truncated_note = True
    edges_truncated_note = False
    if len(edges) > MAX_EDGES_IN_OUTPUT:
        edges = edges[:MAX_EDGES_IN_OUTPUT]
        edges_truncated_note = True

    max_suspicion = hotspots[0]["suspicion"] if hotspots else 0

    summary = {
        "repo_dir": str(root),
        "file_count": len(file_records),
        "noise_dir_count": len(noise_markers),
        "edge_count": len(edges),
        "manifest_count": len(manifests),
        "install_script_count": len(install_scripts),
        "hotspot_count": len(hotspots),
        "max_suspicion": max_suspicion,
        "languages": dict(sorted(languages.items(), key=lambda kv: -kv[1])),
        "static_scan_ran": scan_error is None and bool(scan_paths),
        "static_scan_note": scan_error,
        "content_truncated": files_truncated,
        "files_array_truncated": files_truncated_note,
        "edges_array_truncated": edges_truncated_note,
    }

    return {
        "summary": summary,
        "files": files_out,
        "noise": noise_markers,
        "edges": edges,
        "manifests": manifests,
        "install_scripts": install_scripts,
        "hotspots": hotspots,
    }


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: knowledge_graph.py <repo_dir> [--out path]", file=sys.stderr)
        return 2
    repo_dir = argv[0]
    out_path = None
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 < len(argv):
            out_path = argv[i + 1]
    try:
        graph = build_graph(repo_dir)
    except (NotADirectoryError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    payload = json.dumps(graph, indent=2)
    if out_path:
        Path(out_path).write_text(payload, encoding="utf-8")
        s = graph["summary"]
        print(
            f"wrote {out_path}: {s['file_count']} files, {s['edge_count']} edges, "
            f"{s['hotspot_count']} hotspots, max_suspicion={s['max_suspicion']}",
            file=sys.stderr,
        )
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
