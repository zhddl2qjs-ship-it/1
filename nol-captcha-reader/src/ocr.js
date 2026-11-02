/* Offline CAPTCHA OCR. All engine/model URLs are packaged extension resources. */
(() => {
  'use strict';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const INIT_TIMEOUT = 30000;
  const OCR_TIMEOUT = 15000;
  let engine = null;
  let starting = null;
  let serial = Promise.resolve();
  let generation = 0;
  let rejectActive = null;

  function bounded(task, milliseconds, label) {
    let timer;
    return Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async function terminate() {
    generation++;
    const old = engine;
    engine = null;
    starting = null;
    rejectActive = null;
    if (old) await old.terminate().catch(() => {});
  }

  async function warmup() {
    if (engine) return engine;
    if (starting) return starting;
    if (!globalThis.Tesseract?.createWorker) throw new Error('로컬 OCR 엔진을 불러오지 못했습니다.');
    const currentGeneration = generation;
    let initializationReject;
    const failure = new Promise((_, reject) => { initializationReject = reject; });
    const resource = name => chrome.runtime.getURL(name);
    const creation = Tesseract.createWorker('eng', 1, {
      workerPath: resource('vendor/worker.min.js'),
      corePath: resource('vendor/'),
      langPath: resource('vendor/'),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: () => {},
      errorHandler: error => {
        const reason = new Error(String(error?.message || error || 'OCR worker error'));
        initializationReject(reason);
        if (rejectActive) rejectActive(reason);
      }
    }).then(async worker => {
      if (currentGeneration !== generation) {
        await worker.terminate();
        throw new Error('OCR 초기화가 취소되었습니다.');
      }
      engine = worker;
      await worker.setParameters({
        tessedit_char_whitelist: ALPHABET,
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '0',
        user_defined_dpi: '300'
      });
      return worker;
    });
    starting = bounded(Promise.race([creation, failure]), INIT_TIMEOUT,
      'OCR 엔진 초기화 시간이 초과되었습니다.').catch(async error => {
      await terminate();
      throw new Error(error?.message || String(error || 'OCR 엔진을 초기화하지 못했습니다. 확장프로그램 파일을 확인해주세요.'));
    });
    return starting;
  }

  function preprocessPixels(imageData, { bridgeGap = 0, threshold = 0.4, minimumComponentArea = 11 } = {}) {
    const { width, height, data } = imageData;
    if (!width || !height || width > 2048 || height > 1024 || data.length !== width * height * 4) throw new Error('지원하지 않는 이미지 크기입니다.');
    const histogram = new Map();
    for (let p = 0; p < width * height; p++) {
      const i = p * 4, key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const entry = histogram.get(key) || { count: 0, minX: width, maxX: 0, minY: height, maxY: 0 };
      entry.count++; entry.minX = Math.min(entry.minX, p % width); entry.maxX = Math.max(entry.maxX, p % width);
      entry.minY = Math.min(entry.minY, Math.floor(p / width)); entry.maxY = Math.max(entry.maxY, Math.floor(p / width));
      histogram.set(key, entry);
    }
    const palette = [...histogram].sort((a, b) => b[1].count - a[1].count);
    const unpack = key => [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    const background = unpack(palette[0][0]);
    const distance2 = (a, b) => a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0);
    const foregroundEntry = palette.find(([key]) => distance2(unpack(key), background) > 1600);
    if (!foregroundEntry) throw new Error('문자와 배경을 구분할 수 없습니다.');
    const foreground = unpack(foregroundEntry[0]);
    // An interference line can lie on the same RGB axis as the glyphs. Its
    // distinct, spatially long/thin palette entry must be excluded explicitly.
    const lineColors = palette.filter(([key, stat]) => key !== palette[0][0] && key !== foregroundEntry[0] &&
      stat.count >= width * 0.45 && stat.maxX - stat.minX >= width * 0.7 && stat.maxY - stat.minY <= height * 0.25)
      .map(([key]) => unpack(key));
    const vector = foreground.map((value, i) => value - background[i]);
    const magnitude2 = vector.reduce((sum, value) => sum + value * value, 0);
    const tolerance2 = Math.max(24, Math.sqrt(magnitude2) * 0.18) ** 2;
    const mask = new Uint8Array(width * height), occluded = new Uint8Array(mask.length);
    for (let p = 0; p < mask.length; p++) {
      const i = p * 4, color = [data[i], data[i + 1], data[i + 2]];
      if (lineColors.some(line => distance2(color, line) < 100)) { occluded[p] = 1; continue; }
      const delta = color.map((value, j) => value - background[j]);
      const fraction = delta.reduce((sum, value, j) => sum + value * vector[j], 0) / magnitude2;
      const residual2 = delta.reduce((sum, value, j) => sum + (value - fraction * vector[j]) ** 2, 0);
      mask[p] = fraction > threshold && fraction < 1.4 && residual2 < tolerance2 ? 1 : 0;
    }
    if (bridgeGap > 0) {
      // Restore only short gaps known to be covered by the detected line.
      // Do this before component cleanup so small but genuine stroke fragments survive.
      for (let x = 0; x < width; x++) {
        let previous = -1;
        for (let y = 0; y < height; y++) {
          if (!mask[y * width + x]) continue;
          if (previous >= 0 && y - previous > 1 && y - previous <= bridgeGap + 1) {
            let covered = false;
            for (let j = previous + 1; j < y; j++) covered ||= Boolean(occluded[j * width + x]);
            if (covered) for (let j = previous + 1; j < y; j++) mask[j * width + x] = 1;
          }
          previous = y;
        }
      }
    }
    const visited = new Uint8Array(mask.length), clean = new Uint8Array(mask.length);
    const minimumArea = Math.max(4, Math.round(height * minimumComponentArea / 70));
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || visited[p]) continue;
      const stack = [p], component = []; visited[p] = 1;
      let minY = height, maxY = 0, minX = width, maxX = 0;
      while (stack.length) {
        const current = stack.pop(), y = Math.floor(current / width), x = current % width;
        component.push(current); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
        }
      }
      if (component.length >= minimumArea && (maxY - minY >= 2 || maxX - minX >= 4)) {
        for (const index of component) clean[index] = 1;
      }
    }
    const foregroundPixels = clean.reduce((sum, value) => sum + value, 0);
    if (foregroundPixels < 30) throw new Error('인식할 문자가 충분하지 않습니다.');
    const output = new Uint8ClampedArray(data.length);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const columns = new Uint16Array(width);
    for (let p = 0; p < clean.length; p++) {
      const value = clean[p] ? 0 : 255;
      output[p * 4] = output[p * 4 + 1] = output[p * 4 + 2] = value; output[p * 4 + 3] = 255;
      if (clean[p]) { const x = p % width, y = Math.floor(p / width); columns[x]++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    const ranges = [];
    for (let x = 0; x < width; x++) {
      if (!columns[x]) continue;
      const start = x;
      while (x + 1 < width && columns[x + 1]) x++;
      ranges.push({ x: start, width: x - start + 1 });
    }
    return { width, height, data: output, foreground, background, lineRemoved: lineColors.length > 0,
      bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, ranges };
  }

  function imageBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 3000000 ||
        !/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
      throw new Error('지원하지 않는 이미지 데이터입니다.');
    }
    let decoded;
    try {
      decoded = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    } catch {
      throw new Error('이미지의 Base64 데이터가 올바르지 않습니다.');
    }
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    const begins = signature => signature.every((value, index) => bytes[index] === value);
    let mime;
    // The site's data URL says JPEG while the supplied bytes are PNG. Use the
    // byte signature, not the declared MIME type, for the decoder's Blob.
    if (begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) mime = 'image/png';
    else if (begins([0xff, 0xd8, 0xff])) mime = 'image/jpeg';
    else if (begins([0x47, 0x49, 0x46, 0x38]) && [0x37, 0x39].includes(bytes[4]) && bytes[5] === 0x61) mime = 'image/gif';
    else if (begins([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) mime = 'image/webp';
    else throw new Error('지원하지 않거나 손상된 이미지 파일입니다.');
    if (mime === 'image/png' && bytes.length >= 24) {
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      checkDimensions(header.getUint32(16), header.getUint32(20));
    }
    return new Blob([bytes], { type: mime });
  }

  function checkDimensions(width, height) {
    if (!width || !height || width > 2048 || height > 1024) {
      throw new Error('지원하지 않는 이미지 크기입니다.');
    }
  }

  function makeCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  async function readPixels(dataUrl) {
    const blob = imageBlob(dataUrl);
    if (typeof createImageBitmap !== 'function') {
      throw new Error('이 브라우저는 이미지 디코더를 지원하지 않습니다. Chrome을 업데이트해주세요.');
    }
    let bitmap;
    let abandoned = false;
    try {
      // Image.decode() can wait for an HTML document's rendering lifecycle.
      // A Blob-backed bitmap is decoded independently of any visible frame.
      const decoding = createImageBitmap(blob).then(result => {
        if (abandoned) {
          result.close();
          throw new Error('이미지 디코딩이 취소되었습니다.');
        }
        return result;
      });
      bitmap = await bounded(decoding, 10000, '이미지 비트맵을 읽는 시간이 초과되었습니다.');
      checkDimensions(bitmap.width, bitmap.height);
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('이미지 처리용 캔버스를 만들 수 없습니다.');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } catch (error) {
      abandoned = true;
      throw new Error(error?.message || '이미지를 디코딩하지 못했습니다.');
    } finally {
      bitmap?.close();
    }
  }

  function canvasFor(pixels, { crop = false, scale = 4, padding = 24 } = {}) {
    const original = makeCanvas(pixels.width, pixels.height);
    original.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    const box = crop ? pixels.bounds : { x: 0, y: 0, width: pixels.width, height: pixels.height };
    const enlarged = makeCanvas(box.width * scale + padding * 2, box.height * scale + padding * 2);
    const context = enlarged.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, enlarged.width, enlarged.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(original, box.x, box.y, box.width, box.height,
      padding, padding, box.width * scale, box.height * scale);
    return enlarged;
  }

  function selectCandidate(candidates) {
    const groups = new Map();
    for (const candidate of candidates.filter(item => item.valid)) {
      const group = groups.get(candidate.text) || [];
      group.push(candidate);
      groups.set(candidate.text, group);
    }
    const ranked = [...groups].map(([text, matches]) => ({
      text, matches, confidence: Math.max(...matches.map(item => item.confidence)),
      supported: matches.filter(item => item.confidence >= 55)
    })).sort((a, b) => b.confidence - a.confidence || b.supported.length - a.supported.length);
    const best = ranked[0];
    const supported = best?.supported || [];
    const variants = new Set(supported.map(item => item.method));
    // A six-letter output alone is not enough. Require agreement from different
    // preprocessing/layout passes and reject plausible competing readings.
    // Engine confidence is a heuristic, not an accuracy percentage.
    const conflicting = best && ranked.slice(1).some(other =>
      other.confidence >= 70 && other.confidence >= best.confidence - 12);
    const submitSafe = Boolean(best && best.confidence >= 70 && variants.size >= 2 && !conflicting);
    const fallback = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      text: best?.text || fallback?.text || '',
      confidence: best?.confidence || fallback?.confidence || 0,
      valid: Boolean(best),
      submitSafe,
      reason: submitSafe ? 'agreement' : !best ? 'not-six-letters' : conflicting ? 'conflicting-readings' : 'low-confidence',
      agreement: best?.matches.length || 0,
      candidates: candidates.map(({ text, confidence, method, valid }) => ({ text, confidence, method, valid }))
    };
  }

  async function runRecognition(dataUrl) {
    // Leave time for the offscreen/background reply before their 55s watchdog.
    const deadline = Date.now() + 50000;
    const pixels = await readPixels(dataUrl);
    const worker = await warmup();
    const candidates = [];
    const masks = new Map();
    const passes = [
      { gap: 0, crop: false, psm: 7 }, { gap: 1, crop: false, psm: 7 },
      { gap: 0, crop: true, psm: 8 }, { gap: 1, crop: true, psm: 8 },
      { gap: 3, crop: false, psm: 7 }, { gap: 3, crop: true, psm: 8 }
    ];
    try {
      for (const { gap, crop, psm } of passes) {
        const remaining = deadline - Date.now();
        if (remaining < 1000) break;
        if (!masks.has(gap)) masks.set(gap, preprocessPixels(pixels, { bridgeGap: gap }));
        const canvas = canvasFor(masks.get(gap), { crop });
        let fail;
        const workerFailure = new Promise((_, reject) => { fail = reject; });
        rejectActive = fail;
        const recognition = (async () => {
          await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
          return worker.recognize(canvas);
        })();
        const { data } = await bounded(Promise.race([recognition, workerFailure]),
          Math.min(OCR_TIMEOUT, remaining), '문자 인식 시간이 초과되었습니다.');
        rejectActive = null;
        const text = String(data.text || '').replace(/\s/g, '').toUpperCase();
        candidates.push({ text, confidence: Math.max(0, Math.min(100, Number(data.confidence) || 0)),
          method: `palette-gap${gap}-${crop ? 'word' : 'line'}`,
          valid: /^[A-Z]{6}$/.test(text) });
      }
      return selectCandidate(candidates);
    } catch (error) {
      await terminate();
      throw new Error(error?.message || String(error));
    } finally {
      rejectActive = null;
    }
  }

  function recognize(dataUrl) {
    const job = serial.catch(() => {}).then(() => runRecognition(dataUrl));
    serial = job;
    return job;
  }

  globalThis.CaptchaOCR = Object.freeze({ recognize, warmup, terminate, preprocessPixels });
})();
