#!/bin/bash
set -e
cd "$(dirname "$0")"
exec ./scripts/start-lan-monitor.sh --pair --install-hooks --open-qr
