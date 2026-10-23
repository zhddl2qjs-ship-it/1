#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo 'SKIP: ScreenCaptureKit configuration tests require macOS.' >&2
  exit 77
fi

TEST_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(cd -- "$TEST_DIR/.." && pwd)"
TEST_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seat-capture-config-tests.XXXXXX")"
trap 'rm -rf "$TEST_BUILD_DIR"' EXIT
mkdir -p "$TEST_BUILD_DIR/module-cache"
SWIFTC_PATH="$(xcrun --find swiftc)"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
TARGET_TRIPLE="$(uname -m)-apple-macos13.0"

"$SWIFTC_PATH" -target "$TARGET_TRIPLE" -sdk "$SDK_PATH" \
  -swift-version 5 -parse-as-library -O -module-cache-path "$TEST_BUILD_DIR/module-cache" \
  -framework CoreGraphics -framework CoreMedia -framework CoreVideo -framework ScreenCaptureKit \
  "$PROJECT_DIR/ScreenCaptureConfiguration.swift" "$TEST_DIR/ScreenCaptureConfigurationTests.swift" \
  -o "$TEST_BUILD_DIR/capture-config-tests"

# Scribble freed allocations so an unowned temporary CF object is less likely
# to remain accidentally readable. This applies only to the regression process.
MallocScribble=1 "$TEST_BUILD_DIR/capture-config-tests"
