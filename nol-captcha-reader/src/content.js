(() => {
  'use strict';

  if (globalThis.__nolCaptchaController) return;
  globalThis.__nolCaptchaController = true;

  const INPUT_SELECTOR = 'input[class*="ModalCaptchaText_captchaInput"]';
  const IMAGE_SELECTOR = '[class*="ModalCaptchaText_captchaImage"] img[alt="캡챠 이미지"]';
  const MODAL_SELECTOR = '[class*="ModalLayout_innerWrap"], [role="dialog"]';
  const defaults = { enabled: true, autoSubmit: true };
  const attempts = new Map();
  const revisions = new WeakMap();
  let settings = { ...defaults };
  let ready = false;
  let stopped = false;
  let epoch = 0;
  let activeJob = null;
  let writing = false;
  let scheduled = null;
  let status = {
    state: 'starting',
    message: '캡차 도우미를 준비하고 있습니다.',
    updatedAt: Date.now(),
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    epoch += 1;
    observer.disconnect();
    clearTimeout(scheduled);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('load', onLoad, true);
  }

  function isInvalidated(error) {
    return /extension context invalidated|extension context has been invalidated/i.test(String(error));
  }

  async function send(message) {
    if (stopped) throw new Error('확장프로그램 연결이 종료되었습니다. 페이지를 새로고침하세요.');
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isInvalidated(error)) stop();
      throw error;
    }
  }

  function setStatus(state, message, extra = {}) {
    if (status.state === state && status.message === message && status.text === extra.text) return;
    status = { state, message, ...extra, updatedAt: Date.now() };
    void send({ target: 'background', type: 'status', ...status }).catch(() => {});
  }

  function isVisible(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  }

  function sourceKey(image) {
    // Attribute changes invalidate a result even before a replacement image finishes loading.
    return `${image.getAttribute('src') || ''}\n${image.getAttribute('srcset') || ''}`;
  }

  function findCandidate() {
    for (const input of document.querySelectorAll(INPUT_SELECTOR)) {
      if (!isVisible(input) || input.disabled || input.readOnly) continue;
      const modal = input.closest(MODAL_SELECTOR);
      if (!modal) continue;
      const image = modal.querySelector(IMAGE_SELECTOR);
      if (!image || !isVisible(image) || !image.getAttribute('src')) continue;
      return { input, image, modal, key: sourceKey(image) };
    }
    return null;
  }

  function findSubmit(modal) {
    return [...modal.querySelectorAll('button')].find(button =>
      button.textContent.replace(/\s+/g, '') === '입력완료' && isVisible(button));
  }

  function schedule() {
    if (stopped || scheduled !== null) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      void scan();
    }, 100);
  }

  function onInput(event) {
    if (writing || !event.target.matches?.(INPUT_SELECTOR)) return;
    revisions.set(event.target, (revisions.get(event.target) || 0) + 1);
    schedule();
  }

  function onLoad(event) {
    if (event.target.matches?.(IMAGE_SELECTOR)) schedule();
  }

  function remember(key, record) {
    attempts.set(key, record);
    // Keep only recent challenges in this tab; images are never persisted to storage.
    while (attempts.size > 32) attempts.delete(attempts.keys().next().value);
  }

  function stillCurrent(job, expectedValue = '') {
    return !stopped && settings.enabled && epoch === job.epoch &&
      job.input.isConnected && job.image.isConnected && job.modal.isConnected &&
      isVisible(job.input) && isVisible(job.image) &&
      job.input.closest(MODAL_SELECTOR) === job.modal &&
      job.modal.querySelector(IMAGE_SELECTOR) === job.image &&
      sourceKey(job.image) === job.key &&
      (revisions.get(job.input) || 0) === job.revision &&
      job.input.value === expectedValue && !job.input.disabled && !job.input.readOnly;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function withTimeout(promise, ms, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function imageData(job) {
    const image = job.image;
    const deadline = Date.now() + 8000;
    while (!image.complete || !image.naturalWidth) {
      if (!stillCurrent(job)) throw new Error('캡차 이미지 또는 입력 내용이 변경되었습니다.');
      if (Date.now() >= deadline) throw new Error('캡차 이미지를 불러오지 못했습니다.');
      await delay(80);
    }
    if (!stillCurrent(job)) throw new Error('캡차 이미지 또는 입력 내용이 변경되었습니다.');
    if (image.naturalWidth > 2048 || image.naturalHeight > 2048) {
      throw new Error('지원하는 캡차 이미지 크기를 초과했습니다.');
    }
    const source = image.currentSrc || image.src;
    if (/^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,/i.test(source)) {
      if (source.length > 2_000_000) throw new Error('캡차 이미지 용량이 너무 큽니다.');
      return source;
    }
    // An already loaded same-origin/blob image can also be read without a network request.
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      throw new Error('브라우저가 이 이미지의 읽기를 허용하지 않습니다. 직접 입력해주세요.');
    }
  }

  function fillInput(input, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('입력창의 값을 설정하지 못했습니다.');
    writing = true;
    try {
      // Use the native setter so React's controlled-input tracker receives a real change.
      setter.call(input, text);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      writing = false;
    }
  }

  async function process(job, record) {
    try {
      setStatus('recognizing', '캡차 문자를 인식하고 있습니다.');
      const image = await imageData(job);
      const result = await withTimeout(
        send({ target: 'background', type: 'recognize', image }),
        60000,
        '문자 인식 시간이 초과되었습니다. 확장프로그램에서 다시 시도할 수 있습니다.',
      );
      if (!stillCurrent(job)) {
        if (settings.enabled) setStatus('cancelled', '이미지 또는 입력 내용이 변경되어 자동 입력을 취소했습니다.');
        return;
      }
      if (!result?.ok) throw new Error(result?.error || '문자를 인식하지 못했습니다.');
      const text = String(result.text || '').trim().toUpperCase();
      if (!/^[A-Z]{6}$/.test(text)) {
        throw new Error('영문 6글자를 확실히 읽지 못했습니다. 직접 입력하거나 다시 시도해주세요.');
      }
      fillInput(job.input, text);
      record.text = text;
      if (!stillCurrent(job, text)) {
        setStatus('cancelled', '입력창이 변경되었습니다. 현재 입력 내용을 확인해주세요.');
        return;
      }
      setStatus('filled', '인식한 문자를 입력했습니다.', { text, confidence: result.confidence });
      if (!settings.autoSubmit) return;

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (!settings.autoSubmit || !stillCurrent(job, text)) return;
        const button = findSubmit(job.modal);
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          // Mark the challenge before dispatching click; synchronous DOM changes cannot submit twice.
          if (record.submitted) return;
          record.submitted = true;
          button.click();
          setStatus('submitted', '입력완료 버튼을 눌렀습니다. 사이트의 처리 결과를 확인하세요.', { text });
          return;
        }
        await delay(80);
      }
      if (stillCurrent(job, text)) {
        setStatus('filled', '문자는 입력했지만 입력완료 버튼이 활성화되지 않았습니다.', { text });
      }
    } catch (error) {
      if (isInvalidated(error)) stop();
      if (!stopped && settings.enabled && epoch === job.epoch) {
        setStatus('error', error instanceof Error ? error.message : '문자 인식 중 오류가 발생했습니다.');
      }
    } finally {
      if (activeJob === job) activeJob = null;
      schedule();
    }
  }

  async function scan() {
    if (!ready || stopped || activeJob) return;
    if (!settings.enabled) {
      setStatus('disabled', '자동 인식이 꺼져 있습니다.');
      return;
    }
    const candidate = findCandidate();
    if (!candidate) {
      if (['starting', 'waiting', 'disabled'].includes(status.state)) {
        setStatus('waiting', '캡차 창이 나타나면 자동으로 인식합니다.');
      }
      return;
    }
    if (attempts.has(candidate.key)) return;
    if (candidate.input.value !== '') {
      setStatus('manual', '이미 입력된 문자가 있어 자동 입력을 기다리고 있습니다.');
      return;
    }
    const record = { attempted: true, submitted: false, text: '' };
    remember(candidate.key, record);
    const job = {
      ...candidate,
      epoch,
      revision: revisions.get(candidate.input) || 0,
    };
    activeJob = job;
    await process(job, record);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'value', 'disabled', 'class', 'style', 'hidden', 'aria-hidden'],
  });
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('load', onLoad, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || stopped) return;
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue ?? defaults.enabled;
      epoch += 1;
      if (!settings.enabled) setStatus('disabled', '자동 인식이 꺼져 있습니다.');
      else setStatus('waiting', '캡차 창이 나타나면 자동으로 인식합니다.');
    }
    if (changes.autoSubmit) settings.autoSubmit = changes.autoSubmit.newValue ?? defaults.autoSubmit;
    schedule();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'content') return;
    if (message.type === 'getStatus') {
      sendResponse({ ok: true, ...status, detected: Boolean(findCandidate()) });
      return;
    }
    if (message.type === 'retry') {
      const candidate = findCandidate();
      if (!settings.enabled) {
        sendResponse({ ok: false, error: '자동 인식을 먼저 켜주세요.' });
      } else if (activeJob) {
        sendResponse({ ok: false, error: '현재 인식이 진행 중입니다.' });
      } else if (!candidate) {
        sendResponse({ ok: false, error: '화면에서 캡차 입력창을 찾지 못했습니다.' });
      } else if (candidate.input.value !== '') {
        sendResponse({ ok: false, error: '다시 시도하려면 캡차 입력창을 먼저 비워주세요.' });
      } else {
        attempts.delete(candidate.key);
        setStatus('waiting', '같은 이미지를 다시 인식합니다.');
        schedule();
        sendResponse({ ok: true });
      }
    }
  });

  void chrome.storage.local.get(defaults).then(values => {
    settings = { ...defaults, ...values };
    ready = true;
    schedule();
  }).catch(error => {
    if (isInvalidated(error)) stop();
    else setStatus('error', '확장프로그램 설정을 읽지 못했습니다. 페이지를 새로고침하세요.');
  });
})();
