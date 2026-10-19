#!/usr/bin/env bash
# Install / uninstall dsh-easy-sync in an Electron-managed DSH profile.
#
# The Electron app owns `$DSH_HOME/profiles/desktop`, and `dsh plugin --profile
# desktop` refuses to manage it. This script performs the same three edits a
# bundle install would make, with a package.json backup:
#   1. symlink <profile>/node_modules/dsh-easy-sync -> this repository
#   2. add the dependency to <profile>/package.json
#   3. append the bundle to dsh.profile.bundles
#
# Works on macOS and Linux. Fully quit the DeepSeek Harness app before running.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: bash scripts/install-desktop.sh [options]

Options:
  --profile DIR   DSH profile directory
                  (default: $DSH_HOME/profiles/desktop, else ~/.dsh/profiles/desktop)
  --repo DIR      plugin repository (default: the parent of this script)
  --remove, -r    uninstall: remove the symlink, dependency and bundle entry
  --force, -f     proceed even if the app is running, or replace an existing path
  -h, --help      show this help

Examples:
  bash scripts/install-desktop.sh
  bash scripts/install-desktop.sh -r
EOF
}

package_name="dsh-easy-sync"
repo_path="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
profile_dir=""
remove=0
force=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --profile)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "error: --profile needs a directory" >&2; exit 2; }
            profile_dir="$2"
            shift 2
            ;;
        --repo)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "error: --repo needs a directory" >&2; exit 2; }
            repo_path="$2"
            shift 2
            ;;
        --remove|-r)
            remove=1
            shift
            ;;
        --force|-f)
            force=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ -z "$profile_dir" ]]; then
    dsh_home="${DSH_HOME:-$HOME/.dsh}"
    profile_dir="$dsh_home/profiles/desktop"
fi
case "$profile_dir" in
    "~/"*) profile_dir="$HOME/${profile_dir#\~/}" ;;
esac

manifest="$profile_dir/package.json"
modules_dir="$profile_dir/node_modules"
link_path="$modules_dir/$package_name"

echo "dsh-easy-sync installer"
echo "  repository : $repo_path"
echo "  profile    : $profile_dir"

if [[ ! -f "$repo_path/package.json" ]]; then
    echo "error: plugin package.json not found: $repo_path/package.json" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required to edit $manifest safely." >&2
    echo "       Install Node.js >= 22.15 (https://nodejs.org or 'brew install node')." >&2
    exit 1
fi
if ! node -e 'const p = require(process.argv[1]); process.exit(p.name === "dsh-easy-sync" ? 0 : 1)' "$repo_path/package.json"; then
    echo "error: unexpected package name in $repo_path/package.json (expected $package_name)" >&2
    exit 1
fi
if [[ ! -f "$manifest" ]]; then
    echo "error: desktop profile manifest not found: $manifest" >&2
    echo "       Has the desktop app been started at least once on this device?" >&2
    exit 1
fi

# PATH is expanded before this script name, so the app may also appear as
# "DeepSeek Harness Helper"; matching the main bundle name is good enough.
if [[ $force -eq 0 ]] && pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
    echo "error: DeepSeek Harness appears to be running." >&2
    echo "       Fully quit it first, or pass --force if you know what you are doing." >&2
    exit 1
fi

backup="$manifest.dsh-easy-sync.bak-$(date +%Y%m%d-%H%M%S)-$$"
cp -p "$manifest" "$backup"

# The manifest edit runs in Node so it is a real JSON parse/stringify instead of
# a fragile text substitution; it also validates the result before writing.
edit_manifest() {
    node - "$manifest" "$package_name" "$repo_path" "$1" <<'NODE'
const fs = require('node:fs')

const [manifestPath, packageName, repoPath, removing] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  throw new Error(`${manifestPath} is not a JSON object`)
}
if (manifest.dependencies === undefined || manifest.dependencies === null) manifest.dependencies = {}
if (manifest.dsh === undefined || manifest.dsh === null) manifest.dsh = {}
if (manifest.dsh.profile === undefined || manifest.dsh.profile === null) manifest.dsh.profile = {}
const bundled = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string') : []

if (removing === '1') {
  delete manifest.dependencies[packageName]
  manifest.dsh.profile.bundles = bundled.filter((item) => item !== packageName)
} else {
  manifest.dependencies[packageName] = `file:${repoPath}`
  if (!bundled.includes(packageName)) bundled.push(packageName)
  manifest.dsh.profile.bundles = bundled
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
NODE
}

if [[ $remove -eq 1 ]]; then
    if [[ -e "$link_path" || -L "$link_path" ]]; then
        rm -rf "$link_path"
        echo "removed link $link_path"
    fi
    edit_manifest 1
    echo "uninstalled; backed up manifest to $backup"
    echo "Fully restart DeepSeek Harness."
    exit 0
fi

mkdir -p "$modules_dir"
if [[ -e "$link_path" || -L "$link_path" ]]; then
    if [[ $force -eq 1 ]]; then
        rm -rf "$link_path"
    else
        echo "error: $link_path already exists (pass --force to replace it)" >&2
        exit 1
    fi
fi
ln -s "$repo_path" "$link_path"
echo "linked $link_path -> $repo_path"

edit_manifest 0
echo "installed dsh-easy-sync into the desktop profile"
echo "  backup: $backup"
echo "Fully quit and reopen DeepSeek Harness for the plugin to load."
