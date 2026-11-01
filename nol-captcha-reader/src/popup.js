'use strict';
const $ = id => document.getElementById(id);
let tabId;

function render(status) {
  $('status').textContent = status?.message || '캡차 이미지가 나타나면 자동으로 처리합니다.';
  $('result').textContent = status?.text || '';
}

async function refresh() {
  const settings = await chrome.storage.local.get({enabled: true, autoSubmit: true});
  $('enabled').checked = settings.enabled;
  $('autoSubmit').checked = settings.autoSubmit;
  $('autoSubmit').disabled = !settings.enabled;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  tabId = tab?.id;
  try {
    const status = await chrome.tabs.sendMessage(tabId, {target: 'content', type: 'getStatus'});
    render(status);
    $('retry').disabled = !settings.enabled;
  } catch {
    $('retry').disabled = true;
    render({message: 'NOL 예매 페이지에서 사용하세요. 설치 후에는 해당 페이지를 새로고침해야 합니다.'});
  }
}

for (const key of ['enabled', 'autoSubmit']) {
  $(key).addEventListener('change', async () => {
    await chrome.storage.local.set({[key]: $(key).checked});
    await refresh();
  });
}

$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  try {
    const reply = await chrome.tabs.sendMessage(tabId, {target: 'content', type: 'retry'});
    if (!reply?.ok) render({message: reply?.error || '입력창을 비운 뒤 다시 시도하세요.'});
    else await refresh();
  } catch {
    render({message: '페이지를 새로고침한 뒤 다시 시도하세요.'});
  } finally {
    $('retry').disabled = !$('enabled').checked;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes['tabStatus:' + tabId]) render(changes['tabStatus:' + tabId].newValue);
});
refresh().catch(error => render({message: error.message}));
