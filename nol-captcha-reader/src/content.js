(() => {
  'use strict';
  if (globalThis.__nolCaptchaController) return;
  globalThis.__nolCaptchaController = true;

  const INPUT_SELECTOR = 'input[class*="ModalCaptchaText_captchaInput"]';
  const IMAGE_SELECTOR = '[class*="ModalCaptchaText_captchaImage"] img[alt="캡챠 이미지"]';
  const MODAL_SELECTOR = '[class*="ModalLayout_innerWrap"], [role="dialog"]';
  const ERROR_SELECTOR = '[class*="ModalCaptchaText_captchaError"]';
  const REFRESH_SELECTOR = 'button[aria-label="새 문자 불러오기"], button[class*="ModalCaptchaText_buttonRefresh"]';
  const defaults = { enabled: true, autoSubmit: true, autoRetry: true, maxRetries: 5 };
  const revisions = new WeakMap();
  let settings = { ...defaults };
  let ready = false, stopped = false, writing = false;
  let epoch = 0, activeJob = null, scheduled = null, session = null;
  let status = { state: 'starting', message: '캡차 도우미를 준비하고 있습니다.', updatedAt: Date.now() };

  function maxRetries() {
    const value = Number(settings.maxRetries);
    return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.floor(value))) : defaults.maxRetries;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    epoch++;
    observer.disconnect();
    clearTimeout(scheduled);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('load', onLoad, true);
    document.removeEventListener('click', onClick, true);
  }
  function isInvalidated(error) {
    return /extension context invalidated|extension context has been invalidated/i.test(String(error));
  }
  async function send(message) {
    if (stopped) throw new Error('확장프로그램 연결이 종료되었습니다. 페이지를 새로고침하세요.');
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { if (isInvalidated(error)) stop(); throw error; }
  }
  function setStatus(state, message, extra = {}) {
    const retryCount = session?.retries || 0;
    if (status.state === state && status.message === message && status.text === extra.text && status.retryCount === retryCount) return;
    status = { state, message, ...extra, retryCount, maxRetries: maxRetries(), updatedAt: Date.now() };
    void send({ target: 'background', type: 'status', ...status }).catch(() => {});
  }
  function isVisible(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  }
  function sourceKey(image) {
    return `${image.getAttribute('src') || ''}\n${image.getAttribute('srcset') || ''}`;
  }
  function findCandidate(modalOnly = null) {
    const root = modalOnly || document;
    for (const input of root.querySelectorAll(INPUT_SELECTOR)) {
      if (!isVisible(input)) continue;
      const modal = input.closest(MODAL_SELECTOR);
      if (!modal || (modalOnly && modal !== modalOnly)) continue;
      const image = modal.querySelector(IMAGE_SELECTOR);
      if (!image || !isVisible(image) || !image.getAttribute('src')) continue;
      return { input, image, modal, key: sourceKey(image) };
    }
    return null;
  }
  function errorText(modal) {
    const node = modal.querySelector(ERROR_SELECTOR);
    return node && isVisible(node) ? node.textContent.trim() : '';
  }
  function findSubmit(modal) {
    return [...modal.querySelectorAll('button')].find(button =>
      button.textContent.replace(/\s+/g, '') === '입력완료' && isVisible(button));
  }
  function findRefresh(modal) {
    return [...modal.querySelectorAll(REFRESH_SELECTOR)].find(button =>
      isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  }
  function getSession(candidate) {
    if (!session || session.modal !== candidate.modal) {
      session = { modal: candidate.modal, input: candidate.input, attempts: new Map(), retries: 0,
        manualPaused: false, halted: false, haltReason: '', owned: null, errorVersion: 0, acceptedFreshKey: '',
        manualRefreshKey: '', manualRefreshDeadline: 0 };
    } else if (session.input !== candidate.input) {
      // React can remount the field when refreshing; retain this modal's retry budget.
      session.input = candidate.input;
    }
    return session;
  }
  function schedule(ms = 100) {
    if (stopped || scheduled !== null) return;
    scheduled = setTimeout(() => { scheduled = null; void scan(); }, ms);
  }
  function onInput(event) {
    if (!settings.enabled || writing || !event.target.matches?.(INPUT_SELECTOR)) return;
    revisions.set(event.target, (revisions.get(event.target) || 0) + 1);
    if (session && event.target.closest(MODAL_SELECTOR) === session.modal) {
      session.manualPaused = true;
      epoch++;
      setStatus('manual', '직접 입력한 내용이 있어 자동 처리를 멈췄습니다. 다시 시도로 재개할 수 있습니다.');
    }
    schedule();
  }
  function onLoad(event) { if (event.target.matches?.(IMAGE_SELECTOR)) schedule(); }
  function onClick(event) {
    const button = event.target.closest?.(REFRESH_SELECTOR);
    if (!settings.enabled || !event.isTrusted || !button || !session || button.closest(MODAL_SELECTOR) !== session.modal) return;
    const candidate = findCandidate(session.modal);
    epoch++;
    // A user-requested new challenge also discards the previous answer.
    if (candidate && !candidate.input.disabled && !candidate.input.readOnly) fillInput(candidate.input, '');
    session.manualPaused = false;
    session.halted = false;
    session.haltReason = '';
    session.retries = 0;
    session.attempts.clear();
    session.owned = null;
    session.acceptedFreshKey = '';
    session.manualRefreshKey = candidate?.key || '';
    session.manualRefreshDeadline = Date.now() + 10000;
    setStatus('waiting', '새 문자를 기다리고 있습니다.');
    schedule();
  }
  function remember(s, key, record) {
    s.attempts.set(key, record);
    while (s.attempts.size > 32) s.attempts.delete(s.attempts.keys().next().value);
  }
  function sessionCurrent(job) {
    return !stopped && settings.enabled && session === job.session && !job.session.manualPaused &&
      epoch === job.epoch && job.modal.isConnected && isVisible(job.modal);
  }
  function baseCurrent(job) {
    return sessionCurrent(job) && job.input.isConnected &&
      isVisible(job.input) && job.input.closest(MODAL_SELECTOR) === job.modal &&
      (revisions.get(job.input) || 0) === job.revision;
  }
  function stillCurrent(job, expectedValue = '') {
    return baseCurrent(job) && job.image.isConnected && isVisible(job.image) &&
      job.modal.querySelector(IMAGE_SELECTOR) === job.image && sourceKey(job.image) === job.key &&
      job.input.value === expectedValue && !job.input.disabled && !job.input.readOnly;
  }
  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function withTimeout(promise, ms, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  function fillInput(input, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('입력창의 값을 설정하지 못했습니다.');
    writing = true;
    try {
      setter.call(input, text);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally { writing = false; }
  }
  async function imageData(job) {
    const deadline = Date.now() + 8000;
    while (!job.image.complete || !job.image.naturalWidth) {
      if (!stillCurrent(job)) throw new Error('캡차 이미지 또는 입력 내용이 변경되었습니다.');
      if (Date.now() >= deadline) throw new Error('캡차 이미지를 불러오지 못했습니다.');
      await delay(80);
    }
    if (!stillCurrent(job)) throw new Error('캡차 이미지 또는 입력 내용이 변경되었습니다.');
    if (job.image.naturalWidth > 2048 || job.image.naturalHeight > 2048) throw new Error('지원하는 캡차 이미지 크기를 초과했습니다.');
    const source = job.image.currentSrc || job.image.src;
    if (/^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,/i.test(source)) {
      if (source.length > 2_000_000) throw new Error('캡차 이미지 용량이 너무 큽니다.');
      return source;
    }
    const canvas = document.createElement('canvas');
    canvas.width = job.image.naturalWidth;
    canvas.height = job.image.naturalHeight;
    canvas.getContext('2d').drawImage(job.image, 0, 0);
    try { return canvas.toDataURL('image/png'); }
    catch { throw new Error('브라우저가 이 이미지의 읽기를 허용하지 않습니다. 직접 입력해주세요.'); }
  }
  function canClear(s, candidate) {
    return candidate.input.value === '' || candidate.input.value === s.owned?.text || Boolean(errorText(candidate.modal));
  }
  function halt(s, message, reason = 'refresh') {
    s.halted = true;
    s.haltReason = reason;
    setStatus('error', message);
  }
  async function recover(job, reason, alreadyFresh = false) {
    const s = job.session;
    if (!baseCurrent(job) || !settings.autoRetry) return;
    let candidate = findCandidate(job.modal);
    if (!candidate || candidate.input !== job.input || candidate.input.disabled || candidate.input.readOnly) return;
    if (!canClear(s, candidate)) {
      s.manualPaused = true;
      setStatus('manual', '기존 입력 내용을 보호하기 위해 재시도를 멈췄습니다.');
      return;
    }
    if (candidate.input.value !== '') fillInput(candidate.input, '');
    if (!baseCurrent(job)) return;
    if (s.retries >= maxRetries()) {
      halt(s, `자동 재시도 ${maxRetries()}회를 마쳤습니다. 다시 시도로 재개하거나 직접 입력해주세요.`, 'limit');
      return;
    }
    s.retries++;
    const startingKey = candidate.key;
    setStatus('retrying', `${reason} 새 문자를 불러옵니다. (${s.retries}/${maxRetries()})`);
    const pauseUntil = Date.now() + 800;
    while (Date.now() < pauseUntil) {
      if (!baseCurrent(job) || !settings.autoRetry) return;
      await delay(80);
    }
    candidate = findCandidate(job.modal);
    if (!baseCurrent(job) || !settings.autoRetry || !candidate || candidate.input !== job.input) return;
    if (candidate.input.value !== '') {
      if (!canClear(s, candidate)) { s.manualPaused = true; setStatus('manual', '입력 내용이 변경되어 재시도를 멈췄습니다.'); return; }
      fillInput(candidate.input, '');
    }
    // The server may have already replaced the rejected challenge. Do not refresh twice.
    let fresh = alreadyFresh || candidate.key !== startingKey;
    if (!fresh) {
      const button = findRefresh(job.modal);
      if (!button) { halt(s, '새 문자 불러오기 버튼을 사용할 수 없습니다. 다시 시도하거나 직접 입력해주세요.'); return; }
      button.click();
    }
    const deadline = Date.now() + 10000;
    while (sessionCurrent(job) && settings.autoRetry) {
      if (Date.now() >= deadline) {
        halt(s, '새 이미지가 나타나지 않아 재시도를 멈췄습니다. 같은 문자는 다시 제출하지 않습니다.');
        return;
      }
      candidate = findCandidate(job.modal);
      if (candidate && candidate.input !== job.input) {
        // Refresh responses can remount React's field. User edits anywhere in
        // the modal invalidate the session, so adopting an untouched field is safe.
        if (revisions.get(candidate.input)) {
          s.manualPaused = true;
          setStatus('manual', '입력 내용이 변경되어 재시도를 멈췄습니다.');
          return;
        }
        job.input = candidate.input;
        job.revision = 0;
        s.input = candidate.input;
      }
      if (candidate && candidate.input === job.input && (fresh || candidate.key !== startingKey)) {
        if (candidate.input.disabled || candidate.input.readOnly) { await delay(80); continue; }
        if (candidate.input.value !== '') {
          if (!canClear(s, candidate)) { s.manualPaused = true; setStatus('manual', '입력 내용이 변경되어 재시도를 멈췄습니다.'); return; }
          fillInput(candidate.input, '');
        }
        s.attempts.delete(candidate.key);
        s.acceptedFreshKey = candidate.key;
        setStatus('waiting', '새 문자를 불러왔습니다. 다시 인식합니다.');
        return;
      }
      await delay(80);
    }
  }
  async function process(job, record) {
    const s = job.session;
    try {
      setStatus('recognizing', '캡차 문자를 인식하고 있습니다.');
      const image = await imageData(job);
      const result = await withTimeout(send({ target: 'background', type: 'recognize', image }), 60000,
        '문자 인식 시간이 초과되었습니다.');
      if (!stillCurrent(job)) {
        if (settings.enabled && !s.manualPaused) setStatus('cancelled', '이미지 또는 입력 내용이 변경되어 이전 결과를 취소했습니다.');
        return;
      }
      if (!result?.ok) throw new Error(result?.error || '문자를 인식하지 못했습니다.');
      const text = String(result.text || '').trim().toUpperCase();
      if (!/^[A-Z]{6}$/.test(text)) throw new Error('영문 6글자를 정확히 읽지 못했습니다.');
      if (result.submitSafe !== true) {
        record.failure = '인식 결과가 불확실합니다.';
        setStatus('review', '인식 결과가 불확실해 자동 입력을 멈췄습니다. 후보를 확인하고 직접 입력하거나 새 문자를 불러오세요.', { text, confidence: result.confidence });
        await recover(job, record.failure);
        return;
      }
      fillInput(job.input, text);
      record.text = text;
      s.owned = { key: job.key, text, submitted: false };
      if (!stillCurrent(job, text)) {
        if (!s.manualPaused) setStatus('cancelled', '입력창이 변경되었습니다. 현재 입력 내용을 확인해주세요.');
        return;
      }
      setStatus('filled', '인식한 문자를 입력했습니다.', { text, confidence: result.confidence });
      if (!settings.autoSubmit) return;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (!settings.autoSubmit || !stillCurrent(job, text)) return;
        const button = findSubmit(job.modal);
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          if (record.submitted) return;
          // Consume queued input/error mutations before recording the submission boundary.
          onMutations(observer.takeRecords());
          record.submitted = true;
          record.submittedAt = Date.now();
          record.errorAtSubmit = errorText(job.modal);
          record.errorVersion = s.errorVersion;
          s.owned.submitted = true;
          button.click();
          setStatus('submitted', '입력완료 버튼을 눌렀습니다. 사이트의 처리 결과를 확인하고 있습니다.', { text });
          schedule(350);
          return;
        }
        await delay(80);
      }
      if (stillCurrent(job, text)) setStatus('filled', '문자는 입력했지만 입력완료 버튼이 활성화되지 않았습니다.', { text });
    } catch (error) {
      if (isInvalidated(error)) stop();
      if (!stopped && stillCurrent(job)) {
        record.failure = error instanceof Error ? error.message : '문자 인식 중 오류가 발생했습니다.';
        setStatus('error', record.failure);
        await recover(job, record.failure);
      }
    }
  }
  async function run(candidate, action) {
    const s = getSession(candidate);
    const job = { ...candidate, session: s, epoch, revision: revisions.get(candidate.input) || 0 };
    activeJob = job;
    try { await action(job, s); }
    catch (error) {
      if (isInvalidated(error)) stop();
      if (baseCurrent(job)) halt(s, error instanceof Error ? error.message : '자동 처리 중 오류가 발생했습니다.');
    } finally {
      if (activeJob === job) activeJob = null;
      schedule();
    }
  }
  async function scan() {
    if (!ready || stopped || activeJob) return;
    if (!settings.enabled) { setStatus('disabled', '자동 인식이 꺼져 있습니다.'); return; }
    const candidate = findCandidate();
    if (!candidate) {
      if (session && !isVisible(session.modal)) {
        const submitted = session.owned?.submitted;
        session = null;
        setStatus(submitted ? 'completed' : 'waiting', submitted ? '캡차 창이 닫혀 자동 처리를 마쳤습니다.' : '캡차 창이 나타나면 자동으로 인식합니다.');
      } else if (!session) setStatus('waiting', '캡차 창이 나타나면 자동으로 인식합니다.');
      return;
    }
    const s = getSession(candidate);
    if (s.manualPaused || s.halted || candidate.input.disabled || candidate.input.readOnly) return;
    if (s.manualRefreshKey) {
      if (candidate.key === s.manualRefreshKey) {
        if (Date.now() >= s.manualRefreshDeadline) halt(s, '새 이미지가 나타나지 않아 자동 처리를 멈췄습니다.');
        else schedule(200);
        return;
      }
      s.manualRefreshKey = '';
      s.acceptedFreshKey = candidate.key;
    }
    const record = s.attempts.get(candidate.key);
    const rejection = errorText(candidate.modal);
    const freshOwned = s.owned && candidate.key !== s.owned.key &&
      (candidate.input.value === '' || candidate.input.value === s.owned.text);
    if (freshOwned && settings.autoRetry) {
      if (s.acceptedFreshKey !== candidate.key) {
        await run(candidate, job => recover(job, '이미지가 변경되어 이전 입력을 지웁니다.', true));
        return;
      }
      if (candidate.input.value !== '') fillInput(candidate.input, '');
    }
    if (rejection && (record?.submitted || (!record && candidate.input.value !== ''))) {
      if (!settings.autoRetry) { setStatus('error', '사이트에서 입력을 거절했습니다. 직접 수정하거나 다시 시도해주세요.', { text: candidate.input.value }); return; }
      if (record?.submitted) {
        const age = Date.now() - record.submittedAt;
        const changed = record.errorAtSubmit !== rejection || s.errorVersion > record.errorVersion;
        // An unchanged error from the previous challenge is not a response to
        // this submission. Wait for new validation evidence, not a time limit.
        if (!changed) return;
        if (age < 300) { schedule(Math.max(100, 300 - age)); return; }
      }
      await run(candidate, job => recover(job, '사이트에서 입력을 거절했습니다.'));
      return;
    }
    if (record?.failure && settings.autoRetry) {
      await run(candidate, job => recover(job, record.failure));
      return;
    }
    if (record) return;
    if (candidate.input.value !== '') {
      setStatus('manual', '이미 입력된 문자가 있어 자동 입력을 기다리고 있습니다.');
      return;
    }
    const newRecord = { submitted: false, text: '', failure: '' };
    remember(s, candidate.key, newRecord);
    await run(candidate, job => process(job, newRecord));
  }
  function onMutations(records) {
    if (session) {
      for (const mutation of records) {
        const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        if (element?.closest?.(ERROR_SELECTOR) && session.modal.contains(element)) session.errorVersion++;
        else if (mutation.type === 'childList' && session.modal.contains(element)) {
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
          if (changedNodes.some(node => node.nodeType === Node.ELEMENT_NODE &&
              (node.matches(ERROR_SELECTOR) || node.querySelector(ERROR_SELECTOR)))) session.errorVersion++;
        }
      }
    }
    schedule();
  }
  const observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'srcset', 'value', 'disabled', 'class', 'style', 'hidden', 'aria-hidden'] });
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('load', onLoad, true);
  document.addEventListener('click', onClick, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || stopped) return;
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue ?? defaults.enabled;
      epoch++;
      if (!settings.enabled) setStatus('disabled', '자동 인식이 꺼져 있습니다.');
      else {
        if (session) { session.manualPaused = false; session.halted = false; session.haltReason = ''; session.retries = 0; session.attempts.clear(); session.acceptedFreshKey = ''; session.manualRefreshKey = ''; }
        setStatus('waiting', '캡차 창이 나타나면 자동으로 인식합니다.');
      }
    }
    for (const key of ['autoSubmit', 'autoRetry', 'maxRetries']) {
      if (changes[key]) settings[key] = changes[key].newValue ?? defaults[key];
    }
    if (session?.haltReason === 'limit' && session.retries < maxRetries()) { session.halted = false; session.haltReason = ''; }
    schedule();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.target !== 'content') return;
    if (message.type === 'getStatus') { respond({ ok: true, ...status, retryCount: session?.retries || 0, maxRetries: maxRetries(), detected: Boolean(findCandidate()) }); return; }
    if (message.type !== 'retry') return;
    const candidate = findCandidate();
    if (!settings.enabled) { respond({ ok: false, error: '자동 인식을 먼저 켜주세요.' }); return; }
    if (activeJob) { respond({ ok: false, error: '현재 인식 또는 새 문자 불러오기가 진행 중입니다.' }); return; }
    if (!candidate) { respond({ ok: false, error: '화면에서 캡차 입력창을 찾지 못했습니다.' }); return; }
    const s = getSession(candidate);
    if (candidate.input.value !== '' && (!errorText(candidate.modal) || s.manualPaused)) {
      respond({ ok: false, error: '다시 시도하려면 캡차 입력창을 먼저 비워주세요.' }); return;
    }
    epoch++;
    s.manualPaused = false; s.halted = false; s.haltReason = ''; s.retries = 0;
    s.acceptedFreshKey = '';
    s.manualRefreshKey = '';
    s.attempts.delete(candidate.key);
    setStatus('waiting', '캡차 자동 처리를 다시 시작합니다.');
    schedule();
    respond({ ok: true });
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
