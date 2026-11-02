#!/usr/bin/env bash
set -euo pipefail
version='1.0.2'
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
NOL 캡차 자동 입력 1.0.2 / Chrome·Edge 116 이상
기존 설치 업데이트: chrome://extensions에서 NOL 확장프로그램의 새로고침(↻) 버튼을 누른 다음 예매 페이지도 새로고침하세요.
처음 설치: chrome://extensions 또는 edge://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드 → 이 폴더 선택.
기본값은 자동 인식·입력·클릭 켜짐입니다. 대상은 https://tickets.interpark.com/* 입니다.
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
