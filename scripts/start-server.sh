#!/bin/sh
# Docker default command; explicit import/update commands bypass this launcher.
set -eu
cd "$(dirname "$0")/.."
node scripts/check-index.mjs
exec node dist/index.js
