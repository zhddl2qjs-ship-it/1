"use strict";
const openButton = document.getElementById("open");
const grantButton = document.getElementById("grant");
const errorBox = document.getElementById("error");
const framesBox = document.getElementById("frames");
const framesText = document.getElementById("framesText");
let lockedOrigins = [];   // 접근 권한이 아직 없는 프레임의 origin 들

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("열려 있는 탭을 찾지 못했습니다.");
  return tab.id;
}

// 접근 가능한 모든 프레임에 넣는다. 프레임 쪽이 막혀 실패하면 최상위 프레임만이라도 연다.
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["watcher.js"] });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["watcher.js"] });
  }
}

// 이 페이지에 들어 있는 (충분히 큰) 다른 출처 iframe 중, 확장프로그램이 아직 접근할 수 없는 곳의 origin 목록
async function findLockedFrames(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      origin: location.origin,
      srcs: [...document.querySelectorAll("iframe, frame")].filter(f => f.clientWidth >= 150 && f.clientHeight >= 80).map(f => f.src),
    }),
  });
  if (!result) return [];
  const origins = new Set();
  for (const src of result.srcs) {
    try {
      const url = new URL(src);
      if (/^https?:$/.test(url.protocol) && url.origin !== result.origin) origins.add(url.origin);
    } catch { /* about:blank, srcdoc 등은 건너뜀 */ }
  }
  const locked = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) locked.push(origin);
  }
  return locked;
}

// 아이콘을 눌러 팝업이 열리면 바로 패널을 연다(클릭 한 번 절약). 버튼은 실패했을 때 다시 시도하는 용도다.
async function openPanel() {
  openButton.disabled = true;
  openButton.textContent = "여는 중…";
  errorBox.textContent = "";
  try {
    const tabId = await activeTabId();
    await inject(tabId);
    lockedOrigins = await findLockedFrames(tabId).catch(() => []);
    if (!lockedOrigins.length) { window.close(); return; }
    framesText.textContent = `이 페이지에는 확장프로그램이 아직 접근하지 못하는 프레임이 있습니다 (${lockedOrigins.map(o => new URL(o).hostname).join(", ")}). 예매 버튼이 프레임 안에 있다면 아래 버튼으로 이 프레임들만 허용하세요. 패널은 이미 열려 있습니다.`;
    framesBox.hidden = false;
  } catch (error) {
    errorBox.textContent =
      "일반 예매 웹페이지에서 실행하세요. 파일로 연 테스트 화면은 확장프로그램 상세정보에서 ‘파일 URL에 대한 액세스 허용’을 켜야 합니다. (" + error.message + ")";
  }
  openButton.disabled = false;
  openButton.textContent = "다시 열기";
}
openButton.addEventListener("click", openPanel);
openPanel();

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  try {
    // 사용자 클릭 직후 바로 요청해야 Chrome 이 허용 창을 띄워 줍니다.
    const granted = await chrome.permissions.request({ origins: lockedOrigins.map(o => `${o}/*`) });
    if (!granted) { framesText.textContent = "허용하지 않아 프레임 안의 버튼은 사용할 수 없습니다."; return; }
    await inject(await activeTabId());
    framesText.textContent = "허용했습니다. 페이지의 패널에서 ‘프레임 안 패널 열기’를 누르세요. (허용은 chrome://extensions 의 사이트 액세스에서 언제든 해제할 수 있습니다)";
    grantButton.hidden = true;
  } catch (error) {
    framesText.textContent = `허용하지 못했습니다. (${error.message})`;
  } finally {
    grantButton.disabled = false;
  }
});
