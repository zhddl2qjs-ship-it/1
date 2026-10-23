#!/bin/bash
set -euo pipefail

TEST_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(cd -- "$TEST_DIR/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seat-detector-tests.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

COMPILER="${CC:-cc}"
FLAGS=(-std=c11 -O3 -Wall -Wextra -Werror)
case "${1:-}" in
    "") ;;
    --sanitize)
        FLAGS=(-std=c11 -O1 -g -Wall -Wextra -Werror
               -fsanitize=address,undefined -fno-omit-frame-pointer)
        printf '%s\n' 'int main(void) { return 0; }' > "$BUILD_DIR/probe.c"
        if ! "$COMPILER" "${FLAGS[@]}" "$BUILD_DIR/probe.c" -o "$BUILD_DIR/probe"; then
            echo 'SKIP: compiler does not support the requested sanitizers.' >&2
            exit 77
        fi
        "$BUILD_DIR/probe"
        ;;
    *) echo "Usage: $0 [--sanitize]" >&2; exit 2 ;;
esac

"$COMPILER" "${FLAGS[@]}" "$PROJECT_DIR/SeatDetector.c" \
    "$TEST_DIR/detector_tests.c" -lm -o "$BUILD_DIR/detector-tests"
"$BUILD_DIR/detector-tests"

"$COMPILER" "${FLAGS[@]}" "$PROJECT_DIR/SeatTracker.c" \
    "$TEST_DIR/tracker_tests.c" -lm -o "$BUILD_DIR/tracker-tests"
"$BUILD_DIR/tracker-tests"
