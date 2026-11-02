'use strict';

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || message.type !== 'recognize') return false;
  if (sender.id !== chrome.runtime.id) return false;
  const task = queue.then(async () => {
    let timer;
    try {
      const result = await Promise.race([
        window.CaptchaOCR.recognize(message.image),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('문자 인식 시간 초과')), 55000);
        })
      ]);
      return {
        ok: true, text: result.text, confidence: result.confidence,
        submitSafe: result.submitSafe === true,
        reason: typeof result.reason === 'string' ? result.reason : '',
        agreement: Number(result.agreement) || 0
      };
    } catch (error) {
      await window.CaptchaOCR.terminate().catch(() => {});
      return {ok: false, error: error.message || String(error)};
    } finally {
      clearTimeout(timer);
    }
  });
  queue = task.catch(() => {});
  task.then(respond, error => respond({ok: false, error: String(error)}));
  return true;
});
