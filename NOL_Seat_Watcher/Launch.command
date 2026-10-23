#!/bin/bash
# Build the macOS application locally. Requires macOS 13+ and Apple command-line tools.
set -euo pipefail
cd "$(dirname "$0")" || exit 1

PACKAGE_DIR="$PWD"
APP_PATH="$PACKAGE_DIR/SeatWatcher.app"
LOG_PATH="$PACKAGE_DIR/SeatWatcher_build.log"
BUILD_DIR=""
BUILD_PID=""
PROGRESS_PID=""
LOCK_DIR=""

pause_before_exit() {
  if [ -t 0 ]; then
    read -r -p '엔터를 누르면 종료합니다...' || true
  fi
}

fail() {
  printf '\n%s\n' "$1" >&2
  pause_before_exit
  exit 1
}

cleanup() {
  if [ -n "$PROGRESS_PID" ]; then
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
  fi
  if [ -n "$BUILD_PID" ]; then
    kill "$BUILD_PID" 2>/dev/null || true
    wait "$BUILD_PID" 2>/dev/null || true
  fi
  if [ -n "$BUILD_DIR" ] && [ -d "$BUILD_DIR" ]; then
    # An interrupt between the two renames must restore the previous app.
    if [ -d "$BUILD_DIR/PreviousSeatWatcher.app" ] && [ ! -e "$APP_PATH" ]; then
      if ! mv "$BUILD_DIR/PreviousSeatWatcher.app" "$APP_PATH"; then
        printf '기존 앱 백업을 보존했습니다: %s/PreviousSeatWatcher.app\n' "$BUILD_DIR" >&2
        BUILD_DIR=""
      fi
    fi
    if [ -n "$BUILD_DIR" ]; then
      rm -rf -- "$BUILD_DIR"
    fi
  fi
  if [ -n "$LOCK_DIR" ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$(uname -s)" != Darwin ]; then
  fail '이 프로그램은 macOS 13 이상에서 실행해야 합니다.'
fi

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
case "$MACOS_MAJOR" in
  ''|*[!0-9]*) fail 'macOS 버전을 확인할 수 없습니다.' ;;
esac
if [ "$MACOS_MAJOR" -lt 13 ]; then
  fail "macOS 13 이상이 필요합니다. 현재 버전: $MACOS_VERSION"
fi

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1 ||
   ! xcrun --find clang >/dev/null 2>&1; then
  printf '%s\n' 'Apple 명령줄 도구가 필요합니다. 설치 안내가 뜨면 설치한 뒤 Launch.command를 다시 실행하세요.'
  xcode-select --install || true
  fail '설치 완료 후 다시 실행해 주세요.'
fi

for required in main.swift PreviewView.swift ScreenCapture.swift SeatTracking.swift SeatDetector.c SeatDetector.h SeatTracker.c SeatTracker.h SeatBridge.h Info.plist; do
  [ -f "$required" ] || fail "필수 파일이 없습니다: $required — ZIP 전체를 다시 압축 해제하세요."
done

NATIVE_ARCH="$(uname -m)"
case "$NATIVE_ARCH" in
  arm64|x86_64) ;;
  *) fail "지원되지 않는 Mac 아키텍처입니다: $NATIVE_ARCH" ;;
esac

SWIFTC_PATH="$(xcrun --find swiftc)"
CLANG_PATH="$(xcrun --find clang)"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
SWIFT_VERSION="$("$SWIFTC_PATH" --version)"
CLANG_VERSION="$("$CLANG_PATH" --version)"
TARGET_TRIPLE="$NATIVE_ARCH-apple-macos13.0"
SWIFT_SOURCES=( ./*.swift )
C_SOURCES=( ./*.c )
C_HEADERS=( ./*.h )

BUILD_HASH="$({
  printf '%s\n' 'SeatWatcher-v2.2;clang-O3-c11;swift-O-swift5;adhoc-sign' \
    "$TARGET_TRIPLE" "$SDK_PATH" "$SDK_VERSION" "$SWIFTC_PATH" "$SWIFT_VERSION" "$CLANG_PATH" "$CLANG_VERSION"
  shasum -a 256 -- "${SWIFT_SOURCES[@]}" "${C_SOURCES[@]}" "${C_HEADERS[@]}" Info.plist Launch.command
} | shasum -a 256 | awk '{print $1}')"

if [ -x "$APP_PATH/Contents/MacOS/SeatWatcher" ] &&
   [ -f "$APP_PATH/Contents/Resources/build-id" ] &&
   [ "$(cat "$APP_PATH/Contents/Resources/build-id")" = "$BUILD_HASH" ] &&
   codesign --verify --strict "$APP_PATH" >/dev/null 2>&1; then
  printf '%s\n' '이미 빌드된 SeatWatcher를 실행합니다.'
  open "$APP_PATH" || fail '앱 실행에 실패했습니다. 시스템 설정의 개인정보 보호 및 보안을 확인하세요.'
  exit 0
fi

BUILD_LOCK="$PACKAGE_DIR/.SeatWatcher-build.lock"
if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
  fail '이 폴더에서 이미 빌드가 진행 중입니다. 열린 빌드 터미널을 확인하세요. 강제 종료로 남은 잠금이면, 다른 빌드가 없는지 확인한 뒤 .SeatWatcher-build.lock 폴더를 삭제하세요.'
fi
LOCK_DIR="$BUILD_LOCK"
printf '%s\n' "$$" > "$LOCK_DIR/pid"

BUILD_DIR="$(mktemp -d "$PACKAGE_DIR/.SeatWatcher-build.XXXXXX")"
STAGED_APP="$BUILD_DIR/SeatWatcher.app"
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources" "$BUILD_DIR/module-cache"
cp Info.plist "$STAGED_APP/Contents/Info.plist"
printf '%s\n' "$BUILD_HASH" > "$STAGED_APP/Contents/Resources/build-id"

printf '%s\n' 'SeatWatcher v2.2를 최적화 빌드합니다. 처음에는 수 분 걸릴 수 있습니다.'
printf 'Mac: %s · %s · SDK %s\n' "$MACOS_VERSION" "$NATIVE_ARCH" "$SDK_VERSION"
printf '빌드 기록: %s\n' "$LOG_PATH"

build_app() {
  local source object
  local objects=()
  printf '%s\n' "$SWIFT_VERSION"
  printf '\n%s\n' '1/3 색상·좌석 탐지 엔진 컴파일'
  for source in "${C_SOURCES[@]}"; do
    object="$BUILD_DIR/$(basename "${source%.c}").o"
    "$CLANG_PATH" -target "$TARGET_TRIPLE" -isysroot "$SDK_PATH" \
      -std=c11 -O3 -Wall -Wextra -c "$source" -o "$object" || return $?
    objects+=( "$object" )
  done
  printf '\n%s\n' '2/3 macOS 앱 컴파일 및 연결'
  "$SWIFTC_PATH" -target "$TARGET_TRIPLE" -sdk "$SDK_PATH" \
    -swift-version 5 -O -module-name SeatWatcher \
    -module-cache-path "$BUILD_DIR/module-cache" \
    -import-objc-header "$PACKAGE_DIR/SeatBridge.h" \
    -framework AppKit -framework ApplicationServices -framework CoreGraphics \
    -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo \
    "${SWIFT_SOURCES[@]}" "${objects[@]}" \
    -o "$STAGED_APP/Contents/MacOS/SeatWatcher" || return $?
  printf '\n%s\n' '3/3 로컬 앱 서명 확인'
  codesign --force --sign - --timestamp=none \
    --identifier local.example.seatcolorwatcher "$STAGED_APP" || return $?
  codesign --verify --strict "$STAGED_APP" || return $?
}

build_app > "$LOG_PATH" 2>&1 &
BUILD_PID=$!
(
  elapsed=0
  while kill -0 "$BUILD_PID" 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    if kill -0 "$BUILD_PID" 2>/dev/null; then
      printf '빌드 진행 중... %s초 (상세 내용은 SeatWatcher_build.log)\n' "$elapsed"
    fi
  done
) &
PROGRESS_PID=$!

BUILD_RESULT=0
wait "$BUILD_PID" || BUILD_RESULT=$?
BUILD_PID=""
kill "$PROGRESS_PID" 2>/dev/null || true
wait "$PROGRESS_PID" 2>/dev/null || true
PROGRESS_PID=""

if [ "$BUILD_RESULT" -ne 0 ] || [ ! -x "$STAGED_APP/Contents/MacOS/SeatWatcher" ]; then
  cat "$LOG_PATH"
  fail "빌드에 실패했습니다. SeatWatcher_build.log를 확인해 주세요. 기존 앱은 그대로 보존했습니다."
fi

# Keep the previous complete bundle until its replacement is fully built and signed.
if [ -L "$APP_PATH" ] || { [ -e "$APP_PATH" ] && [ ! -d "$APP_PATH" ]; }; then
  fail 'SeatWatcher.app 경로에 일반 앱 폴더가 아닌 파일이 있습니다. 이름을 변경한 뒤 다시 실행하세요.'
fi
if [ -d "$APP_PATH" ]; then
  mv "$APP_PATH" "$BUILD_DIR/PreviousSeatWatcher.app"
fi
if ! mv "$STAGED_APP" "$APP_PATH"; then
  fail '새 앱 설치에 실패했습니다. 폴더의 쓰기 권한을 확인하세요.'
fi

printf '%s\n' '빌드가 완료되었습니다. SeatWatcher를 실행합니다.'
printf '%s\n' '업데이트 후 권한 안내가 반복되면 시스템 설정에서 SeatWatcher 권한을 다시 허용하세요.'
open "$APP_PATH" || fail '앱 실행에 실패했습니다. 시스템 설정의 개인정보 보호 및 보안을 확인하세요.'
