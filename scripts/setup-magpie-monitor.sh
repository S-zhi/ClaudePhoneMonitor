#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  printf 'Usage: scripts/setup-magpie-monitor.sh\nInstalls locked production npm dependencies in the extracted archive. Requires Node 24.13.0 through 24.x.\n'
  exit 0
fi
[[ $# -eq 0 ]] || { printf 'Unexpected argument.\n' >&2; exit 2; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major===24 && minor>=13 ? 0 : 1)' || { printf 'Node 24.13.0 through 24.x is required.\n' >&2; exit 1; }
for directory in packages/protocol services/collector services/relay; do
  npm --prefix "$ROOT/$directory" ci --omit=dev --registry=https://registry.npmjs.org
done
printf 'Production dependencies installed. Run scripts/start-magpie-monitor.sh --check.\n'
