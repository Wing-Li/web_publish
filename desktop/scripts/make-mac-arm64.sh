#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Keep compatibility with environments that require custom TLS handling.
NODE_TLS_REJECT_UNAUTHORIZED=0 npx electron-forge make --platform=darwin --arch=arm64

APP_PATH="$ROOT_DIR/out/QuickPackTool-darwin-arm64/QuickPackTool.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Build artifact not found: $APP_PATH"
  exit 1
fi

# Re-sign the full bundle to avoid invalid code signature structures on target Macs.
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime --timestamp --sign "$APPLE_SIGN_IDENTITY" "$APP_PATH"
else
  codesign --force --deep --sign - "$APP_PATH"
fi

codesign --verify --deep --strict --verbose=2 "$APP_PATH"

RELEASE_DIR="$ROOT_DIR/out/release"
mkdir -p "$RELEASE_DIR"

ZIP_PATH="$RELEASE_DIR/QuickPackTool-darwin-arm64-signed.zip"
if [[ -f "$ZIP_PATH" ]]; then
  rm -f "$ZIP_PATH"
fi

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
echo "Release artifact: $ZIP_PATH"
