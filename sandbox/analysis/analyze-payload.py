#!/usr/bin/env python3
"""
analyze-payload.py — the SEPARATE, DISPOSABLE payload analysis.

Captured payloads are potentially hostile. They are analyzed here, in an
isolated environment that is NEVER the detonation VM and NEVER persistent. Only
INERT captured bytes arrive here (the trap's capture.jsonl); nothing is ever
executed. After this runs, the environment is destroyed.

What it does (all read-only / inert):
  1. Decode the captured would-be payloads (base64 -> bytes -> best-effort text).
  2. Resolve the intended destination domains to IPs — for INTELLIGENCE ONLY.
     We never route to these IPs; we only learn what the code MEANT to reach.
  3. GeoIP the intended IPs (offline mmdb if present, else a best-effort label).
     The lookup is done HERE (off the detonation VM), never on the box that ran
     the untrusted code.
  4. AI-analyze the captured behavior + network intent with Gemini via Vertex
     (ADC token), producing a plain-language intent summary for the forensic
     record. Model: gemini-3.5-flash on the `global` location.

Usage (in the disposable analysis env):
  analyze-payload.py --capture capture.jsonl --behavior behavior.json \
     --out analysis.json [--geoip /path/to/GeoLite2-City.mmdb] \
     [--project gen-lang-client-0062239756] [--no-ai]
"""
import argparse
import base64
import json
import socket
import sys
import urllib.request
from datetime import datetime, timezone

GEMINI_MODEL = "gemini-3.5-flash"
VERTEX_LOCATION = "global"
VERTEX_HOST = "aiplatform.googleapis.com"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_jsonl(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def decode_payload(b64):
    if not b64:
        return {"text": None, "bytes_len": 0, "note": "empty"}
    try:
        raw = base64.b64decode(b64)
    except (ValueError, TypeError):
        return {"text": None, "bytes_len": 0, "note": "undecodable base64"}
    # Best-effort text view; keep it bounded.
    try:
        text = raw.decode("utf-8")
        printable = sum(1 for c in text if c.isprintable() or c in "\r\n\t")
        kind = "text" if printable >= 0.8 * max(len(text), 1) else "binary"
    except UnicodeDecodeError:
        text = None
        kind = "binary"
    return {
        "text": (text[:2000] if text else None),
        "bytes_len": len(raw),
        "kind": kind,
    }


def resolve_intended(host):
    """Resolve a domain to its REAL IP — for intelligence only. We never connect
    to this IP; we only record what the code intended to reach."""
    if not host:
        return None
    try:
        infos = socket.getaddrinfo(host, None)
        ips = sorted({i[4][0] for i in infos})
        return ips
    except (socket.gaierror, OSError):
        return []


def geoip_lookup(ip, reader):
    if not ip:
        return None
    if reader is not None:
        try:
            r = reader.city(ip)
            return {
                "ip": ip,
                "country": r.country.name,
                "country_iso": r.country.iso_code,
                "city": r.city.name,
                "lat": r.location.latitude,
                "lon": r.location.longitude,
            }
        except Exception:  # noqa: BLE001
            pass
    # Fallback: classify private vs public, no external call.
    label = "private/reserved" if (
        ip.startswith("10.") or ip.startswith("192.168.")
        or ip.startswith("127.") or ip.startswith("169.254.")
        or any(ip.startswith(f"172.{i}.") for i in range(16, 32))
    ) else "public (geo unavailable — no GeoIP db present)"
    return {"ip": ip, "country": None, "note": label}


def ai_intent_summary(behavior, intents, decoded, project):
    """Call Gemini via Vertex (ADC) to summarize the captured intent. Returns
    (summary_text, error). Inert: we send TEXT describing the capture, never
    execute anything."""
    try:
        import google.auth
        import google.auth.transport.requests
    except ImportError:
        return None, "google-auth not installed in analysis env"

    try:
        creds, adc_project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        creds.refresh(google.auth.transport.requests.Request())
        token = creds.token
        project = project or adc_project
    except Exception as e:  # noqa: BLE001
        return None, f"ADC auth failed: {e}"

    if not project:
        return None, "no GCP project for Vertex"

    agg = behavior.get("aggregate_observations", {}) if isinstance(behavior, dict) else {}
    facts = {
        "project_type": behavior.get("project_type"),
        "high_value_credential_reads": agg.get("high_value_cred_read_count", 0),
        "intended_destinations": [i.get("intended_host") for i in intents if i.get("intended_host")],
        "ports": sorted({i.get("dest_port") for i in intents if i.get("dest_port")}),
        "decoded_payload_samples": [d.get("text") for d in decoded if d.get("text")][:5],
        "high_cpu": bool(agg.get("high_cpu")),
    }
    prompt = (
        "You are a malware-behavior analyst. Below is a JSON record of what a "
        "piece of unknown code TRIED to do inside a hermetic sandbox: credential "
        "reads, intended network destinations (captured by a sinkhole — nothing "
        "was actually delivered), and decoded would-be payloads. Summarize, in 3-5 "
        "plain sentences, the apparent INTENT and threat. Be precise and honest: "
        "if the evidence is consistent with benign behavior, say so; if it matches "
        "an exfiltration/beacon/mining pattern, say that. Never claim certainty you "
        "do not have. JSON:\n\n" + json.dumps(facts, indent=2)
    )

    url = (
        f"https://{VERTEX_HOST}/v1/projects/{project}/locations/{VERTEX_LOCATION}"
        f"/publishers/google/models/{GEMINI_MODEL}:generateContent"
    )
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        # gemini-3.5-flash thinks by default and will burn the whole token budget
        # on thoughts (returning MAX_TOKENS with no text). For this short forensic
        # summary we disable thinking and leave ample room for the answer.
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1024,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        return (text or None), None
    except Exception as e:  # noqa: BLE001
        return None, f"Vertex call failed: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", required=True, help="trap capture JSONL")
    ap.add_argument("--behavior", help="in-VM behavior report JSON")
    ap.add_argument("--out", required=True, help="path to write analysis JSON")
    ap.add_argument("--geoip", help="optional GeoLite2 .mmdb path")
    ap.add_argument("--project", help="GCP project for Vertex (else ADC default)")
    ap.add_argument("--no-ai", action="store_true", help="skip the Gemini call")
    args = ap.parse_args()

    capture = load_jsonl(args.capture)
    behavior = load_json(args.behavior, {}) if args.behavior else {}

    reader = None
    if args.geoip:
        try:
            import geoip2.database
            reader = geoip2.database.Reader(args.geoip)
        except Exception as e:  # noqa: BLE001
            print(f"[analyze] GeoIP db unavailable: {e}", file=sys.stderr)

    intents = []
    decoded = []
    destinations = []
    geolocations = []
    seen_hosts = set()
    for c in capture:
        if c.get("event") == "sinkd_start":
            continue
        host = c.get("intended_host") or c.get("sni") or c.get("http_host_header")
        dec = decode_payload(c.get("payload_b64"))
        decoded.append({"host": host, **dec})
        intents.append({"intended_host": host, "dest_port": c.get("dest_port")})
        if host and host not in seen_hosts:
            seen_hosts.add(host)
            ips = resolve_intended(host)   # INTELLIGENCE ONLY — never routed to
            destinations.append({"host": host, "intended_ips": ips})
            for ip in (ips or []):
                geo = geoip_lookup(ip, reader)
                if geo:
                    geolocations.append({"host": host, **geo})

    ai_summary, ai_err = (None, "skipped")
    if not args.no_ai:
        ai_summary, ai_err = ai_intent_summary(behavior, intents, decoded, args.project)

    analysis = {
        "schema": "claude-rabbit/payload-analysis@1",
        "analyzed_at": now_iso(),
        "isolated_disposable_env": True,
        "decoded_payloads": decoded,
        "destinations": destinations,        # host -> intended real IPs (intel only)
        "geolocations": geolocations,        # off-VM GeoIP of intended IPs
        "ai_model": GEMINI_MODEL if not args.no_ai else None,
        "ai_intent_summary": ai_summary,
        "error": ai_err if (ai_err and ai_err != "skipped") else None,
    }
    with open(args.out, "w") as f:
        json.dump(analysis, f, indent=2)
    print(json.dumps(analysis, indent=2))


if __name__ == "__main__":
    main()
