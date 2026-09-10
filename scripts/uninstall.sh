#!/usr/bin/env bash
# dsh-tradewatcher uninstall helper.
# Usage: bash scripts/uninstall.sh [profile-dir]
set -euo pipefail

PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "profile not found: $PROFILE_DIR" >&2
  exit 1
fi

node - "$PROFILE_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(process.argv[2], 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
let changed = false
if (pkg.dependencies && pkg.dependencies['dsh-tradewatcher']) {
  delete pkg.dependencies['dsh-tradewatcher']
  changed = true
}
const bundles = pkg.dsh?.profile?.bundles ?? []
const idx = bundles.indexOf('dsh-tradewatcher')
if (idx !== -1) {
  bundles.splice(idx, 1)
  changed = true
}
if (!changed) {
  console.log('dsh-tradewatcher is not registered in', file)
  process.exit(0)
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('removed dsh-tradewatcher from', file)
EOF

echo "syncing profile dependencies…"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile) || true
else
  echo "pnpm not found — run manually:  (cd $PROFILE_DIR && pnpm install)" >&2
fi

echo "✅ done — restart dsh web to fully unload the plugin."
