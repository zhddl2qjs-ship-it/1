"use strict";
// 화면(탭) 캡처로 버튼 색을 읽어 주는 서비스 워커.
// DOM 에서 색을 읽을 수 없는 버튼(이미지·캔버스·SVG 등)을 위한 보조 수단이며,
// 캡처한 화면은 저장·전송하지 않고 요청받은 몇 개 지점의 색(RGB)만 돌려준 뒤 버립니다.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || message?.type !== "booking-sample") return false;
  sampleTab(sender.tab, message).then(sendResponse, error => sendResponse(describe(error)));
  return true;   // 비동기 응답
});

function describe(error) {
  const text = String(error?.message ?? error);
  if (error?.code === "inactive") return { code: "inactive", error: text };
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS|quota/i.test(text)) return { code: "quota", error: text };
  if (/activeTab|<all_urls>|permission|cannot access/i.test(text)) return { code: "permission", error: text };
  return { code: "other", error: text };
}

async function ensureActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw Object.assign(new Error("이 탭이 앞에 보이지 않습니다."), { code: "inactive" });
}

async function sampleTab(tab, { points, vw, vh }) {
  if (!Array.isArray(points) || !points.length || points.length > 64 || !(vw > 0) || !(vh > 0)) throw new Error("잘못된 요청입니다.");
  await ensureActive(tab.id);                       // 다른 탭의 화면을 읽는 일이 없도록
  // PNG 는 인코드·디코드가 느리다(큰 화면에서 수십~100ms). 읽는 것은 버튼 안쪽 몇 지점의 색뿐이라 JPEG(품질 92)로 충분하다:
  // 단색 면의 색 오차는 1단계 이하(검증함). 품질 100은 오히려 PNG보다 느려서 쓰지 않는다.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 92 });
  await ensureActive(tab.id);
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const sx = bitmap.width / vw, sy = bitmap.height / vh;     // 화면 배율(DPR·브라우저 확대)을 이미지 크기에서 직접 계산
    const clamp = (v, max) => Math.min(Math.max(Math.round(v), 0), max);
    const px = points.map(([x, y]) => [clamp(x * sx, bitmap.width - 1), clamp(y * sy, bitmap.height - 1)]);
    const x0 = Math.min(...px.map(p => p[0])), x1 = Math.max(...px.map(p => p[0]));
    const y0 = Math.min(...px.map(p => p[1])), y1 = Math.max(...px.map(p => p[1]));
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);          // 필요한 영역만 잘라서 읽는다
    const data = ctx.getImageData(0, 0, w, h).data;
    return { colors: px.map(([x, y]) => { const i = ((y - y0) * w + (x - x0)) * 4; return [data[i], data[i + 1], data[i + 2]]; }) };
  } finally {
    bitmap.close();
  }
}
