#!/usr/bin/env bash
# Verify the vendored libraries match their pinned checksums (supply-chain
# guard: a silently modified vendor/jsQR.js would fail here).
set -euo pipefail
cd "$(dirname "$0")/../vendor"
sha256sum -c CHECKSUMS.sha256
