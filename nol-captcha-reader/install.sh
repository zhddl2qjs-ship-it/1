#!/usr/bin/env bash
set -euo pipefail
version='1.0.3'
is_nol_install() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/manifest.json" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"NOL 캡차 자동 입력"' "$1/manifest.json" &&
    grep -Eq '"manifest_version"[[:space:]]*:[[:space:]]*3' "$1/manifest.json"
}
if [ "$#" -gt 0 ]; then
  dest="$1"
elif is_nol_install "$HOME/Downloads/nol-captcha-reader-1.0.0"; then
  dest="$HOME/Downloads/nol-captcha-reader-1.0.0"
elif is_nol_install "$HOME/Downloads/nol-captcha-reader-1.0.1"; then
  dest="$HOME/Downloads/nol-captcha-reader-1.0.1"
elif is_nol_install "$HOME/Downloads/nol-captcha-reader-1.0.2"; then
  dest="$HOME/Downloads/nol-captcha-reader-1.0.2"
else
  dest="$HOME/Downloads/nol-captcha-reader-$version"
fi
case "$dest" in /*) ;; *) dest="$PWD/$dest" ;; esac
if [ -e "$dest" ] || [ -L "$dest" ]; then
  is_nol_install "$dest" || { echo "NOL 설치 폴더가 아니므로 변경하지 않습니다: $dest" >&2; exit 1; }
fi
for cmd in curl tar gzip base64 grep; do
  command -v "$cmd" >/dev/null || { echo "$cmd 명령이 필요합니다." >&2; exit 1; }
done
tmp=$(mktemp -d)
stage=''
backup=''
swapping=0
cleanup() {
  code=$?
  trap - EXIT
  if [ "$swapping" = 1 ] && [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$dest" ]; then
    mv "$backup" "$dest" || echo "복구가 필요합니다. 백업 위치: $backup" >&2
  fi
  if [ -n "$stage" ] && [ -d "$stage" ]; then rm -rf "$stage"; fi
  rm -rf "$tmp"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$tmp/app/vendor/licenses"
cat > "$tmp/source.b64" <<'NOL_SOURCE'
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
NOL_SOURCE
if [ "$(uname -s)" = Darwin ]; then
  base64 -D < "$tmp/source.b64" > "$tmp/source.tgz"
else
  base64 --decode < "$tmp/source.b64" > "$tmp/source.tgz"
fi
tar -xzf "$tmp/source.tgz" -C "$tmp/app"
base=https://cdn.jsdelivr.net/npm
get() { curl --fail --silent --show-error --location --retry 2 "$1" -o "$2"; }
echo "NOL 캡차 $version: OCR 엔진·모델 약 16 MB를 내려받고 검증합니다."
for file in tesseract.min.js worker.min.js tesseract.min.js.LICENSE.txt worker.min.js.LICENSE.txt; do
  get "$base/tesseract.js@5.1.1/dist/$file" "$tmp/app/vendor/$file"
done
for flavor in lstm simd-lstm; do
  for ext in wasm wasm.js; do
    file="tesseract-core-$flavor.$ext"
    get "$base/tesseract.js-core@5.1.1/$file" "$tmp/app/vendor/$file"
  done
done
get "$base/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz" "$tmp/app/vendor/eng.traineddata.gz"
get "$base/tesseract.js@5.1.1/LICENSE.md" "$tmp/app/vendor/licenses/tesseract-js-LICENSE.md"
get "$base/tesseract.js-core@5.1.1/LICENSE" "$tmp/app/vendor/licenses/tesseract-core-LICENSE"
cp "$tmp/app/vendor/licenses/tesseract-core-LICENSE" "$tmp/app/vendor/licenses/traineddata-LICENSE"
cat > "$tmp/app/vendor/SHA256SUMS" <<'NOL_HASHES'
a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8  tesseract.min.js
aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc  worker.min.js
cdf963ced7d25a0f98901a547647b4d6e2dbe0197fd78c87a059a87b0e542fe2  tesseract.min.js.LICENSE.txt
45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac  worker.min.js.LICENSE.txt
5db58ea4d1bd4256be81e8ae3b4fa226c4625dfba1850b1b3308dbf3700e9929  tesseract-core-lstm.wasm
8f04aa0cc81e7bde33f80e92fa01a7a665f0b4884d098acf5de9c7104a11dfaa  tesseract-core-lstm.wasm.js
66b601224a0c4a8977bc9d92dd39841189f9ca22cc4122fcd7208cdb0961eeef  tesseract-core-simd-lstm.wasm
ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf  tesseract-core-simd-lstm.wasm.js
45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91  eng.traineddata.gz
NOL_HASHES
if command -v shasum >/dev/null; then
  (cd "$tmp/app/vendor" && shasum -a 256 -c SHA256SUMS)
else
  (cd "$tmp/app/vendor" && sha256sum -c SHA256SUMS)
fi
cat > "$tmp/app/README.txt" <<'NOL_README'
NOL 캡차 자동 입력 1.0.3 / Chrome·Edge 116 이상
기존 설치 업데이트: chrome://extensions에서 NOL 확장프로그램의 새로고침(↻) 버튼을 누른 다음 예매 페이지도 새로고침하세요.
처음 설치: chrome://extensions 또는 edge://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드 → 이 폴더 선택.
기본값은 자동 인식·입력·클릭 켜짐입니다. 대상은 https://tickets.interpark.com/* 입니다.
1.0.3: OCR 엔진에 내장된 data: 형식의 WASM 데이터를 읽을 때 발생하던 connect-src CSP 차단 오류를 수정했습니다. 확장프로그램 정책에서 이 로컬 데이터 읽기를 허용하며 외부 서버 연결을 추가하지 않습니다.
업데이트 후에도 이전 오류가 보이면 확장프로그램 오류 화면의 기존 기록을 지운 다음 예매 페이지에서 새로 확인하세요.
1.0.2: 문자 인식을 교차 확인하고, 인식 실패·오답이면 기존 입력을 지운 뒤 새 문자로 재시도합니다. 기본 최대 재시도는 5회이며 팝업에서 0~20회로 조절할 수 있습니다.
입력완료 버튼은 같은 모달 안에서 활성화된 뒤 한 번만 클릭합니다. 이미 입력한 값과 인식 중 사용자 편집을 덮어쓰지 않습니다.
자동 재시도 중 사용자가 직접 입력하면 자동 처리를 멈춥니다. 다시 시작하려면 입력을 비우고 확장프로그램 팝업에서 자동 처리 다시 시작을 선택하세요.
OCR은 기기 안에서 실행되며 이미지를 외부 OCR 서비스에 보내지 않습니다. 설치 시에만 CDN에서 고정 버전 파일을 내려받습니다.
검증 범위는 GitHub의 VALIDATION.md를 참고하세요. 실제 확장프로그램 설치 및 예매 서버 인증은 미검증입니다.
Tesseract.js 5.1.1 / Tesseract.js-core 5.1.1 / @tesseract.js-data/eng 1.0.0. 라이선스는 vendor/licenses에 있습니다.
설치 폴더를 삭제·이동하면 확장프로그램이 작동하지 않습니다.
NOL_README
# Prepare on the destination filesystem before changing any existing installation.
parent=$(dirname "$dest")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.nol-captcha-stage.XXXXXX")
cp -R "$tmp/app" "$stage/app"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  is_nol_install "$dest" || { echo "설치 대상이 변경되어 중단합니다: $dest" >&2; exit 1; }
  backup="$dest.backup-$(date +%Y%m%d-%H%M%S)-$$"
  [ ! -e "$backup" ] || { echo "백업 경로가 이미 존재합니다: $backup" >&2; exit 1; }
  mv "$dest" "$backup"
  swapping=1
fi
mv "$stage/app" "$dest"
swapping=0
printf '\n완료: NOL 캡차 %s\n설치 폴더: %s\n' "$version" "$dest"
if [ -n "$backup" ]; then printf '이전 버전 백업: %s\n' "$backup"; fi
printf 'Chrome: chrome://extensions\nEdge: edge://extensions\n기존 설치: 확장프로그램의 새로고침(↻) 버튼 → 버전 확인 → 예매 페이지 새로고침\n처음 설치: 개발자 모드 → 압축해제된 확장 프로그램 로드 → 위 폴더 선택\n'
if [ "${NOL_NO_OPEN:-0}" != 1 ] && [ "$(uname -s)" = Darwin ]; then
  open -a 'Google Chrome' 'chrome://extensions' 2>/dev/null || true
fi
