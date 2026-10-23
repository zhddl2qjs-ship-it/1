# Seat Watcher 2.2 — 맥북용 수정본

자동 갱신되는 예매 화면에서 지정한 영역의 파랑·초록·보라색 원형 좌석을 감지합니다. 테스트 모드로 위치를 확인하거나 좌석을 한 번 클릭하고 멈춥니다.

macOS 13 이상에서 Apple 명령줄 도구로 직접 빌드하는 소스 배포본입니다. Apple Silicon 및 Intel Mac을 대상으로 합니다.

## ZIP 없이 받기

맥북 터미널에서 다음을 실행하세요. 기존 폴더를 덮어쓰지 않습니다.

```sh
git clone --branch codex/seat-watcher-v2.2 --single-branch https://github.com/zhddl2qjs-ship-it/1.git ~/Downloads/SeatWatcher-v2.2
cd ~/Downloads/SeatWatcher-v2.2/NOL_Seat_Watcher
bash Launch.command
```

Apple 명령줄 도구 설치 안내가 나오면 설치 후 다시 실행하세요. 첫 빌드 후 `SeatWatcher.app`이 같은 폴더에 생성됩니다. 화면 기록 권한이 필요하며, 자동 클릭에는 손쉬운 사용 권한도 필요합니다.

## 먼저 확인하기

`NOL_Seat_Watcher/테스트화면.html`을 브라우저에서 열면 실제 예매 없이 좌석 표시·확대·재등장·클릭을 확인할 수 있습니다. 앱은 테스트 모드가 기본입니다. 이미 보이는 좌석으로 테스트하려면 '시작할 때 있는 좌석 제외'를 끄세요.

색상 분류, 확대된 얇은 원형 좌석, 좌석 재등장 추적을 수정했습니다. ScreenCaptureKit으로 선택 영역을 연속 캡처하고, 연속 2회 확인·화면 조작 시 중지·창 정보 재확인·1회 클릭 후 중지를 적용했습니다.

실제 C 감지/추적 코드의 375개 검증 항목과 메모리 오류 검사를 통과했습니다. **Linux에서 제작했으므로 실제 Mac의 Swift 빌드, 화면 권한, Retina 좌표, 반응 시간과 예매 성공은 미검증입니다.**

사용법은 `NOL_Seat_Watcher/README.md`, 자세한 검증 범위는 `NOL_Seat_Watcher/검증결과.txt`를 참고하세요. 빌드가 실패하면 같은 폴더의 `SeatWatcher_build.log`에 오류가 기록됩니다.
