# Build and validation notes

- Minimum deployment target: macOS 13.0.
- Native architectures: arm64 and x86_64, built on the user's Mac.
- Apple command-line tools provide `clang`, `swiftc`, and the macOS SDK.
- The launcher compiles `SeatDetector.c` and `SeatTracker.c` with `-std=c11 -O3`, then all package-root Swift sources with `-swift-version 5 -O` and `SeatBridge.h` as the C bridging header.
- Linked frameworks: AppKit, ApplicationServices, CoreGraphics, ScreenCaptureKit, CoreMedia, CoreVideo.
- A complete staged application is ad-hoc signed and verified before replacing the existing app. This is local signing, not Apple notarization or a Developer ID distribution signature. macOS privacy approval may need renewing after rebuilding.
- Reuse is based on content hashes of Swift/C/header/plist/launcher files, target architecture, compiler paths and versions, and SDK path/version. A signed bundle is verified before reuse.
- Build output is recorded in `SeatWatcher_build.log`. A failed build preserves the previous application bundle.
- Runtime screen capture uses ScreenCaptureKit rather than the obsolete `CGDisplayCreateImage` API.
- The user reports macOS 26.6.1. This package has not been compiled or run on that Mac or any macOS host during preparation. No macOS build-success claim is made.
- Native C tests exercise the same detector linked into the app. They do not validate Swift/CoreGraphics bridging, capture permissions, screen geometry, UI, click timing, or ticket reservation behavior.

## Mac verification before using automatic clicks

1. Build using `Launch.command`; check the complete build log if it fails.
2. Allow screen capture and test a region near the top, then near the bottom of the main display.
3. Confirm Retina scaling: the displayed detection position must match the visible seat.
4. Test each enabled color separately, with a small seat and an enlarged seat.
5. Test a static screen, a newly appearing seat, a disappearing/reappearing seat, and a page loading transition.
6. Confirm Escape stops monitoring and switching to another browser window stops or blocks automatic clicking.
7. Enable clicking only after detection is correct in test mode. The app issues at most one click per run and does not confirm that the server reserved the seat.
