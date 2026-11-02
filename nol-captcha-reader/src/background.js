'use strict';

const DEFAULTS = {enabled: true, autoSubmit: true, autoRetry: true, maxRetries: 5};
let creatingOffscreen;
let ocrQueue = Promise.resolve();

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the bundled offline image recognition worker.'
      });
    }
  })();
  try { await creatingOffscreen; }
  finally { creatingOffscreen = null; }
}

function timeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('문자 인식 시간이 초과되었습니다. 다시 시도를 눌러주세요.')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(Object.entries(DEFAULTS).filter(([key]) => !(key in current)));
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background') return false;
  const ownPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  const allowedTab = sender.tab && sender.url?.startsWith('https://tickets.interpark.com/');
  if (!ownPage && !allowedTab) {
    respond({ok: false, error: '허용되지 않은 페이지입니다.'});
    return false;
  }
  (async () => {
    if (message.type === 'status') {
      if (sender.tab) {
        await chrome.storage.session.set({['tabStatus:' + sender.tab.id]: {
          state: String(message.state || ''),
          message: String(message.message || '').slice(0, 300),
          text: String(message.text || '').slice(0, 16),
          updatedAt: Date.now()
        }});
      }
      return {ok: true};
    }
    if (message.type === 'recognize') {
      const {enabled} = await chrome.storage.local.get(DEFAULTS);
      if (!enabled) throw new Error('자동 입력이 꺼져 있습니다.');
      if (typeof message.image !== 'string' || message.image.length > 8 * 1024 * 1024 ||
          !/^data:image\/(png|jpe?g|webp);base64,/i.test(message.image)) {
        throw new Error('지원하지 않는 이미지입니다.');
      }
      const task = ocrQueue.then(async () => {
        try {
          if (!(await chrome.storage.local.get(DEFAULTS)).enabled) throw new Error('자동 입력이 꺼져 있습니다.');
          await ensureOffscreen();
          const result = await timeout(chrome.runtime.sendMessage({
            target: 'offscreen', type: 'recognize', image: message.image
          }), 58000);
          if (!result?.ok) throw new Error(result?.error || '문자 인식 결과가 없습니다.');
          if (!/^[A-Z]{6}$/.test(result.text)) throw new Error('6자리 영문자를 정확히 읽지 못했습니다. 직접 입력하거나 새 문자를 불러오세요.');
          return {
            ok: true, text: result.text, confidence: result.confidence,
            submitSafe: result.submitSafe === true,
            reason: typeof result.reason === 'string' ? result.reason.slice(0, 300) : '',
            agreement: Number(result.agreement) || 0
          };
        } catch (error) {
          // Closing the document also cleans up workers whose initialization failed.
          await chrome.offscreen.closeDocument().catch(() => {});
          throw error;
        }
      });
      ocrQueue = task.catch(() => {});
      return task;
    }
    throw new Error('알 수 없는 요청입니다.');
  })().then(respond, error => respond({ok: false, error: error.message || String(error)}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove('tabStatus:' + tabId).catch(() => {});
});
