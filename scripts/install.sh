#!/usr/bin/env bash
# dsh-tradewatcher install helper for a dsh web profile.
#
# Usage:  bash scripts/install.sh [profile-dir] [project-dir]
#   profile-dir  default ${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}
#   project-dir  default the repository root (where this script lives)
#
# What it does:
#   1. builds lib/index.js + lib/client.js if missing
#   2. adds "dsh-tradewatcher": "link:<project>" to the profile's dependencies
#   3. appends dsh-tradewatcher to the profile's dsh.profile.bundles
#   4. runs pnpm install in the profile (needs network for first fetch)
#   5. prints the restart hint (web GUI must be restarted to load the bundle)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"
PROJECT_DIR="${2:-$HERE}"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "profile not found: $PROFILE_DIR (pass the profile dir as \$1 or DSH_PROFILE_DIR)" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/lib/index.js" ] || [ ! -f "$PROJECT_DIR/lib/client.js" ]; then
  echo "building $PROJECT_DIR …"
  (cd "$PROJECT_DIR" && node build.mjs)
fi

node - "$PROFILE_DIR" "$PROJECT_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const [profileDir, projectDir] = process.argv.slice(2)
const file = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
const spec = `link:${projectDir}`
let changed = false
if (pkg.dependencies['dsh-tradewatcher'] !== spec) {
  pkg.dependencies['dsh-tradewatcher'] = spec
  changed = true
}
if (!pkg.dsh.profile.bundles.includes('dsh-tradewatcher')) {
  pkg.dsh.profile.bundles.push('dsh-tradewatcher')
  changed = true
}
if (!changed) {
  console.log('dsh-tradewatcher already registered in', file)
} else {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('registered dsh-tradewatcher in', file)
}
EOF

echo "installing profile dependencies (pnpm)…"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile)
else
  echo "pnpm not found — run manually:  (cd $PROFILE_DIR && pnpm install)" >&2
fi

cat <<EOF

✅ dsh-tradewatcher staged in $PROFILE_DIR

下一步（重要）:
  重启 dsh web 进程使插件装载并生效（客户端 bundle 需重新构建加载）:
    如果你用 dsh CLI 启动:  重启你启动 web profile 的命令/服务
  之后打开侧边栏「+」菜单，选择「大盘概览」页签即可。

  卸载: bash $PROJECT_DIR/scripts/uninstall.sh $PROFILE_DIR
EOF
