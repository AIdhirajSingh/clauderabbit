# detonation-base.Dockerfile — the base image every detonation microVM boots from.
# Carries the in-guest harness, the language runtimes a real build needs, strace for
# observation, and the forge's root CA in the trust store so a NON-pinning TLS client
# (the malware) completes the handshake to the forge and reveals its payload.
# The per-scan image is just `FROM cr-detonation-base` + `COPY <repo> /repo` (a thin
# layer buildkit caches), so detonation start stays fast.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm strace ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*

# The forge CA -> trusted, so the guest's TLS clients trust the forge's per-SNI leaf.
COPY mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/cr-forge-ca.crt
RUN update-ca-certificates
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The in-guest harness (configures egress->forge, plants decoys, runs+observes the repo).
COPY detonate.py /opt/cr/detonate.py
WORKDIR /repo
