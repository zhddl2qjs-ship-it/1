# NOL 캡차 자동 입력 1.0.1

제공된 NOL 예매 HTML 구조에 맞춘 Chrome / Edge 116 이상용 확장프로그램입니다.
캡차 이미지가 나타나면 로컬 OCR로 읽고, 입력창에 입력한 뒤 같은 모달의 활성화된 **입력완료** 버튼을 한 번 클릭합니다.

## macOS / Linux 터미널 설치

아래 명령을 그대로 실행하세요. 실행 시 고정 버전 OCR 엔진과 모델 약 16MB를 다운로드하고 파일을 검증합니다. 기존 기본 경로에 설치되어 있으면 백업한 뒤 같은 폴더를 업데이트합니다.

```bash
mkdir -p "$HOME/Downloads"
curl --fail --location 'https://raw.githubusercontent.com/zhddl2qjs-ship-it/1/codex/nol-captcha-reader-v1.0.0/nol-captcha-reader/install.sh' -o "$HOME/Downloads/nol-captcha-install.sh" &&
bash "$HOME/Downloads/nol-captcha-install.sh"
```

1. Chrome의 `chrome://extensions` 또는 Edge의 `edge://extensions`를 엽니다.
2. **기존 설치 업데이트:** NOL 캡차 확장프로그램 카드의 **새로고침(↻)** 버튼을 누르고 버전이 **1.0.1**인지 확인합니다.
3. **처음 설치:** 개발자 모드를 켜고 **압축해제된 확장 프로그램 로드**에서 스크립트가 출력한 설치 폴더를 선택합니다. 새 설치의 기본 경로는 `~/Downloads/nol-captcha-reader-1.0.1`입니다.
4. 열려 있던 예매 페이지도 새로고침합니다. 이전 내용 스크립트는 확장프로그램만 새로고침해서는 교체되지 않습니다.

브라우저 등록은 화면에서 한 번 직접 해야 합니다. 처음 설치하면 자동 인식과 자동 클릭이 켜져 있습니다.
설치한 폴더는 사용하는 동안 삭제하거나 이동하지 마세요.
기존 기본 설치 폴더 `~/Downloads/nol-captcha-reader-1.0.0`이 있으면 그 경로를 유지합니다. 따라서 Chrome에 확장프로그램을 다시 등록할 필요가 없습니다. 다운로드·검증이 끝난 후에만 교체하며, 이전 파일은 별도 백업 폴더에 보관합니다. 다른 경로에 설치했으면 해당 설치 폴더를 직접 지정하세요. 다른 프로그램의 폴더는 덮어쓰지 않습니다.

```bash
bash "$HOME/Downloads/nol-captcha-install.sh" "/기존/확장프로그램/설치폴더"
```

## 1.0.1 수정 사항

`이미지를 읽는 시간이 초과되었습니다` 오류가 발생하던 DOM 이미지 디코딩 대기 경로를 제거했습니다. 이제 실제 이미지 바이트로 PNG/JPEG 형식을 판별하고 `createImageBitmap`과 `OffscreenCanvas`로 처리합니다. 제한 시간을 늘리는 방식은 사용하지 않았습니다.

새로 제공한 캡차 `CTXCNA`와 기존 세 이미지에서 인식·React 입력·버튼 클릭 테스트가 통과했습니다. 일반 브라우저와 숨긴 iframe에서는 기존 오류 자체를 재현하지 못했으므로, 실제 Chrome offscreen 환경이 정확한 원인인지는 아직 확인하지 못했습니다.

## 동작과 설정

- 대상 사이트: `https://tickets.interpark.com/*`
- 입력창: `input[class*="ModalCaptchaText_captchaInput"]`
- 공통 모달: 가장 가까운 `[class*="ModalLayout_innerWrap"]`
- 이미지: 모달 안의 `[class*="ModalCaptchaText_captchaImage"] img[alt="캡챠 이미지"]`
- 제출: 같은 모달에서 텍스트가 `입력완료`인 활성 버튼

정답은 DOM 텍스트에 들어 있지 않아 이미지 OCR이 필요합니다. 문자·배경 색상을 추정하고 잡음을 제거한 두 이미지의 OCR 결과를 비교합니다.
Native input setter와 `input` / `change` 이벤트로 React에 값을 전달하고 버튼 활성화를 기다립니다.
이미 입력한 값은 덮어쓰지 않으며, 인식 중 사용자 편집이나 이미지 변경이 있으면 이전 결과를 취소합니다. 이미지마다 한 번만 제출합니다.

확장프로그램 아이콘에서 자동 인식 또는 자동 클릭을 끌 수 있습니다.
틀린 경우 직접 수정하거나 사이트의 새 문자 불러오기를 누르세요. 같은 이미지에 다시 시도하려면 입력창을 비우고 팝업의 **현재 이미지 다시 시도**를 누르세요.

## 검증과 범위

실제 브라우저 OCR에서 네 이미지 `TTDUBN`, `UTDUUP`, `LUXQLS`, `CTXCNA`를 확인했고, 실제 React 입력창과 연결한 구성요소 테스트 및 입력 제어 시나리오 12개가 통과했습니다.
실행 환경의 Chromium 관리 정책으로 확장프로그램 설치가 차단되어 실제 설치 상태 검증은 완료하지 못했습니다. 실제 예매 서버에 인증을 제출하지 않았습니다.
새 이미지의 인식 정확도나 인증 성공을 보장하지 않습니다. 자세한 내용은 [VALIDATION.md](VALIDATION.md)를 참고하세요.

## 구성

- `install.sh`: 검증된 소스가 포함된 설치 스크립트. OCR 라이브러리·모델을 다운로드한 뒤 SHA-256을 확인합니다.
- `src/`: 읽을 수 있는 원본 확장프로그램 소스. `vendor/` 런타임 파일은 설치 스크립트가 설치 폴더에 준비합니다. `src/`만 바로 로드하면 작동하지 않습니다.
- `THIRD_PARTY_NOTICES.md`: 사용한 라이브러리 및 모델 정보.

설치 후 OCR은 기기 안에서 실행되며 이미지를 외부 OCR 서비스로 보내지 않습니다. 원본 예매 HTML·캡처 이미지·로그인 정보는 이 배포에 포함하지 않았습니다.
