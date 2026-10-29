#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OJJIPA_OUTPUT_DIR:-$ROOT_DIR/outputs}"
export CARGO_HOME="${OJJIPA_CARGO_HOME:-${TMPDIR:-/tmp}/ojjipa-cargo-home}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This setup builder currently creates DMGs for Apple Silicon Macs." >&2
  exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Install Xcode Command Line Tools with 'xcode-select --install', then retry." >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Install Homebrew from https://brew.sh, then retry." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  brew install node
fi
if ! command -v cargo >/dev/null 2>&1; then
  brew install rust
fi
PYTHON="$(command -v python3.14 || true)"
if [[ -z "$PYTHON" ]]; then
  brew install python@3.14
  PYTHON="$(brew --prefix python@3.14)/bin/python3.14"
fi
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.14 was not found after installation." >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Rust (cargo) and Node.js (npm) must be on PATH. Restart the terminal and retry." >&2
  exit 1
fi

cd "$ROOT_DIR"
git submodule update --init --recursive
if [[ ! -x .venv-hermes/bin/python ]]; then
  "$PYTHON" -m venv .venv-hermes
fi
.venv-hermes/bin/python -m pip install --upgrade pip
.venv-hermes/bin/python -m pip install -e core/vendors/hermes-agent/hermes-agent -r engine/python/requirements.txt

cd "$ROOT_DIR/apps/desktop"
NPM_CACHE="${TMPDIR:-/tmp}/ojjipa-npm-cache"
npm ci --cache "$NPM_CACHE"
npm run tauri build -- --bundles app

APP_BUNDLE="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/OJJIPA.app"
if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "The Tauri build completed without producing OJJIPA.app." >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR"
DMG_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ojjipa-dmg.XXXXXX")"
trap 'rm -rf "$DMG_STAGE"' EXIT
ditto "$APP_BUNDLE" "$DMG_STAGE/OJJIPA.app"
ln -s /Applications "$DMG_STAGE/Applications"
DMG_PATH="$OUTPUT_DIR/OJJIPA-1.0.0-macOS-arm64.dmg"
hdiutil create -volname OJJIPA -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"
hdiutil verify "$DMG_PATH"
echo "Created $OUTPUT_DIR/OJJIPA-1.0.0-macOS-arm64.dmg"
