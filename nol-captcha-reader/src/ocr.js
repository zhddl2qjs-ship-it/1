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

  // Keep the dominant glyph color while discarding the different-colored line.
  // This uses the actual image palette rather than assuming cyan/yellow glyphs.
  function preprocessPixels(imageData, { bridgeGap = 0 } = {}) {
    const { width, height, data } = imageData;
    if (!width || !height || width > 2048 || height > 1024 || data.length !== width * height * 4) {
      throw new Error('지원하지 않는 이미지 크기입니다.');
    }
    const histogram = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
    const palette = [...histogram].sort((a, b) => b[1] - a[1]);
    const unpack = key => [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    const background = unpack(palette[0][0]);
    const distance2 = color => color.reduce((sum, value, i) => sum + (value - background[i]) ** 2, 0);
    const foregroundEntry = palette.find(([key]) => distance2(unpack(key)) > 1600);
    if (!foregroundEntry) throw new Error('문자와 배경을 구분할 수 없습니다.');
    const foreground = unpack(foregroundEntry[0]);
    const vector = foreground.map((value, i) => value - background[i]);
    const magnitude2 = vector.reduce((sum, value) => sum + value * value, 0);
    const tolerance2 = Math.max(24, Math.sqrt(magnitude2) * 0.18) ** 2;
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < mask.length; p++) {
      const offset = p * 4;
      const dr = data[offset] - background[0];
      const dg = data[offset + 1] - background[1];
      const db = data[offset + 2] - background[2];
      const fraction = (dr * vector[0] + dg * vector[1] + db * vector[2]) / magnitude2;
      const residual2 = (dr - fraction * vector[0]) ** 2
        + (dg - fraction * vector[1]) ** 2
        + (db - fraction * vector[2]) ** 2;
      mask[p] = fraction > 0.45 && fraction < 1.4 && residual2 < tolerance2 ? 1 : 0;
    }
    const visited = new Uint8Array(mask.length);
    const clean = new Uint8Array(mask.length);
    const minimumArea = Math.max(6, Math.round(height * 0.16));
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || visited[p]) continue;
      const stack = [p];
      const component = [];
      visited[p] = 1;
      let minY = height, maxY = 0;
      while (stack.length) {
        const current = stack.pop();
        component.push(current);
        const y = Math.floor(current / width);
        const x = current % width;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
            const next = ny * width + nx;
            if (mask[next] && !visited[next]) {
              visited[next] = 1;
              stack.push(next);
            }
          }
        }
      }
      if (component.length >= minimumArea && maxY - minY >= 2) {
        for (const index of component) clean[index] = 1;
      }
    }
    if (bridgeGap > 0) {
      // A second OCR pass repairs only a single removed scanline-sized gap.
      for (let x = 0; x < width; x++) {
        let previous = -1;
        for (let y = 0; y < height; y++) {
          if (!clean[y * width + x]) continue;
          if (previous >= 0 && y - previous > 1 && y - previous <= bridgeGap + 1) {
            for (let fill = previous + 1; fill < y; fill++) clean[fill * width + x] = 1;
          }
          previous = y;
        }
      }
    }
    const foregroundPixels = clean.reduce((sum, value) => sum + value, 0);
    if (foregroundPixels < 30) throw new Error('인식할 문자가 충분하지 않습니다.');
    const output = new Uint8ClampedArray(data.length);
    for (let p = 0; p < clean.length; p++) {
      const value = clean[p] ? 0 : 255;
      output[p * 4] = output[p * 4 + 1] = output[p * 4 + 2] = value;
      output[p * 4 + 3] = 255;
    }
    return { width, height, data: output, foreground, background };
  }

  async function readPixels(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 3000000 ||
        !/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
      throw new Error('지원하지 않는 이미지 데이터입니다.');
    }
    const image = new Image();
    image.src = dataUrl;
    await bounded(image.decode(), 10000, '이미지를 읽는 시간이 초과되었습니다.');
    if (!image.naturalWidth || image.naturalWidth > 2048 || image.naturalHeight > 1024) {
      throw new Error('지원하지 않는 이미지 크기입니다.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }

  function canvasFor(pixels) {
    const original = document.createElement('canvas');
    original.width = pixels.width;
    original.height = pixels.height;
    original.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    const enlarged = document.createElement('canvas');
    enlarged.width = pixels.width * 4;
    enlarged.height = pixels.height * 4;
    const context = enlarged.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(original, 0, 0, enlarged.width, enlarged.height);
    return enlarged;
  }

  async function runRecognition(dataUrl) {
    const pixels = await readPixels(dataUrl);
    const worker = await warmup();
    const candidates = [];
    try {
      for (const gap of [0, 1]) {
        const canvas = canvasFor(preprocessPixels(pixels, { bridgeGap: gap }));
        let fail;
        const workerFailure = new Promise((_, reject) => { fail = reject; });
        rejectActive = fail;
        const { data } = await bounded(Promise.race([
          worker.recognize(canvas), workerFailure
        ]), OCR_TIMEOUT, '문자 인식 시간이 초과되었습니다.');
        rejectActive = null;
        const rawText = String(data.text || '');
        const text = rawText.replace(/\s/g, '').toUpperCase();
        candidates.push({ text, confidence: Number(data.confidence) || 0,
          rawText, method: gap ? 'palette-clean-gap1' : 'palette-clean', valid: /^[A-Z]{6}$/.test(text) });
      }
      const valid = candidates.filter(candidate => candidate.valid);
      const best = (valid.length ? valid : candidates).sort((a, b) => b.confidence - a.confidence)[0];
      return { ...best, agreement: candidates.filter(candidate => candidate.text === best.text).length,
        candidates: candidates.map(({ text, confidence, method, valid }) => ({ text, confidence, method, valid })) };
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
