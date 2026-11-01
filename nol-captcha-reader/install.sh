#!/usr/bin/env bash
set -euo pipefail
version='1.0.1'
is_nol_install() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/manifest.json" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"NOL 캡차 자동 입력"' "$1/manifest.json" &&
    grep -Eq '"manifest_version"[[:space:]]*:[[:space:]]*3' "$1/manifest.json"
}
if [ "$#" -gt 0 ]; then
  dest="$1"
elif is_nol_install "$HOME/Downloads/nol-captcha-reader-1.0.0"; then
  dest="$HOME/Downloads/nol-captcha-reader-1.0.0"
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
NOL 캡차 자동 입력 1.0.1 / Chrome·Edge 116 이상
기존 설치 업데이트: chrome://extensions에서 NOL 확장프로그램의 새로고침(↻) 버튼을 누른 다음 예매 페이지도 새로고침하세요.
처음 설치: chrome://extensions 또는 edge://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드 → 이 폴더 선택.
기본값은 자동 인식·입력·클릭 켜짐입니다. 대상은 https://tickets.interpark.com/* 입니다.
1.0.1: DOM Image.decode() 대기 경로를 없애고, 실제 이미지 파일 형식을 판별하여 createImageBitmap/OffscreenCanvas로 읽습니다.
입력완료 버튼은 같은 모달 안에서 활성화된 뒤 한 번만 클릭합니다. 이미 입력한 값과 인식 중 사용자 편집을 덮어쓰지 않습니다.
틀렸다면 직접 수정하거나 새 문자를 불러오세요. 같은 이미지 재시도는 입력을 비우고 확장프로그램 팝업에서 선택하세요.
OCR은 기기 안에서 실행되며 이미지를 외부 OCR 서비스에 보내지 않습니다. 설치 시에만 CDN에서 고정 버전 파일을 내려받습니다.
네 이미지의 OCR·React 입력 테스트와 멈춘 DOM 디코더를 사용하는 회귀 테스트를 통과했습니다. 실제 확장프로그램 설치 및 예매 서버 인증은 미검증입니다.
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
