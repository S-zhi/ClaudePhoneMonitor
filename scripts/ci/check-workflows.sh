#!/usr/bin/env bash
set -euo pipefail
# CI installs this exact actionlint release; local users can supply ACTIONLINT.
ACTIONLINT_BIN="${ACTIONLINT:-actionlint}"
"$ACTIONLINT_BIN" -version | head -1 | grep -Fx '1.7.7'
"$ACTIONLINT_BIN"
