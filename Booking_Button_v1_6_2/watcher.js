(() => {
  "use strict";
  const KEY = "__bookingButtonOnceV10";
  if (globalThis[KEY]) { globalThis[KEY].show(); return; }

  // ── 프레임 간 통신 ──────────────────────────────────────────────
  // 이 스크립트는 접근 가능한 모든 프레임에 들어오지만, 하위 프레임은 평소엔 아무 UI 도 만들지 않고 대기한다.
  // 패널의 '프레임 안 패널 열기'를 누르면 각 하위 프레임에 신호가 전달되고, 충분히 큰 프레임에만 패널이 열린다.
  // 화면 캡처로 색을 읽을 때는 상위 프레임이 'iframe 의 위치'를 알려 줘서 최상위 화면 좌표로 바꾼다.
  const TAG = KEY;
  const OFFSET_TIMEOUT_MS = 800;
  const MIN_FRAME_W = 200, MIN_FRAME_H = 120;
  const isTop = window === window.top;
  const bridge = { isTop, opened: 0, relay, frameOffset };
  const pendingOffsets = new Map();
  let api = null;
  let seq = 0;

  const send = (win, type, extra = {}) => { try { win.postMessage({ [TAG]: type, ...extra }, "*"); } catch {} };
  function relay(type) { for (let i = 0; i < window.length; i++) send(window[i], type); }
  // 이 프레임의 왼쪽 위 모서리가 최상위 화면에서 어디인지 { x, y, topW, topH }. 알 수 없으면 null.
  function frameOffset() {
    if (isTop) return Promise.resolve({ x: 0, y: 0, topW: innerWidth, topH: innerHeight });
    return new Promise(resolve => {
      const id = `${++seq}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { pendingOffsets.delete(id); resolve(null); }, OFFSET_TIMEOUT_MS);
      pendingOffsets.set(id, value => { clearTimeout(timer); pendingOffsets.delete(id); resolve(value); });
      send(window.parent, "offset?", { id });
    });
  }
  const ensurePanel = () => (api ??= main(bridge));

  window.addEventListener("message", async event => {
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data[TAG] !== "string") return;
    const from = event.source;
    switch (data[TAG]) {
      case "show-panel":
        if (isTop || from !== window.parent) return;
        relay("show-panel");
        if (innerWidth >= MIN_FRAME_W && innerHeight >= MIN_FRAME_H) { ensurePanel().show(); send(window.parent, "opened"); }
        return;
      case "opened":
        if (isTop) bridge.opened++; else send(window.parent, "opened");
        return;
      case "offset?": {   // 자식 프레임이 "내 위치가 어디야?" 하고 묻는다
        const frame = [...document.querySelectorAll("iframe, frame")].find(f => f.contentWindow === from);
        if (!frame || typeof data.id !== "string") return;
        const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame);
        const mine = await frameOffset();
        if (!mine) return;
        send(from, "offset!", {
          id: data.id,
          x: mine.x + rect.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0),
          y: mine.y + rect.top + frame.clientTop + (parseFloat(style.paddingTop) || 0),
          topW: mine.topW, topH: mine.topH,
        });
        return;
      }
      case "offset!": {
        if (from !== window.parent) return;
        const value = { x: Number(data.x), y: Number(data.y), topW: Number(data.topW), topH: Number(data.topH) };
        pendingOffsets.get(data.id)?.(Object.values(value).every(Number.isFinite) ? value : null);
        return;
      }
    }
  });

  // ── 감시 패널 본체 ──────────────────────────────────────────────
  function main(bridge) {
    document.getElementById("booking-button-once-panel")?.remove();   // 이전 버전 패널이 남아 있으면 치운다(이전 버전은 스스로 중지)

    // ── 조정 가능한 값 ─────────────────────────────────────────────
    const WATCH_LIMIT_MS = 60 * 60 * 1000;   // 최대 감시 시간
    const REPLACE_WAIT_MS = 10000;           // 버튼이 DOM에서 사라졌을 때 다시 나타나길 기다리는 시간
    const UNREADABLE_LIMIT_MS = 8000;        // 버튼 색을 읽을 수 없는 상태가 이 시간 이어지면 중지
    // Chrome 은 화면 캡처를 1초에 2회까지만 허용한다. 평소 확인이 그 한도를 거의 다 쓰면 '버튼 근처가 바뀐' 순간에 즉시 캡처할 자리가 없어
    // 변화 알림 기능이 소용없어진다(실측: 알림이 있는 이미지 버튼도 주기 확인과 똑같이 느림). 그래서 평소 확인은 한도의 절반만 쓰고 나머지 한 자리를 비워 둔다.
    const PIXEL_EVENT_FIRST_MS = 1100;      // 기본: 평소 1.1초마다 확인 + 버튼 근처가 바뀌면 곧바로 캡처(알림이 있는 이미지 버튼에 유리)
    const PIXEL_PERIODIC_MS = 550;          // 옵션: 평소에도 0.55초마다 확인(바뀔 때 알림이 없는 캔버스·영상 버튼에 유리, 알림이 있는 버튼은 느려짐)
    const FRAME_MIN_GAP_MS = 4;              // 프레임 루프의 최소 확인 간격(주사율이 아주 높은 화면에서 과열 방지)
    const PIXEL_BURST_MS = 1500;             // 버튼 근처가 바뀐 뒤 이 시간 동안은 가능한 한 빨리(초당 2회 한도 안에서) 연달아 캡처
    const QUOTA_WINDOW_MS = 1100;            // Chrome 은 화면 캡처를 초당 2회까지만 허용 → 어떤 1.1초 구간에도 2회를 넘기지 않는다(여유 100ms)
    const QUOTA_MAX = 2;
    const PIXEL_FRESH_MS = 1800;             // 이보다 오래된 화면 캡처 결과는 쓰지 않음
    const POLL_INTERVAL_MS = 16;             // CSS 애니메이션 등 DOM 알림이 없는 변화를 확인; 백그라운드에서는 Chrome이 늦출 수 있음
    const MIN_CHECK_GAP_MS = 8;             // 일반 페이지 변화의 확인 간격. 대상 버튼의 변경은 이 제한 없이 확인
    const FAST_POLL_MS = 8;                 // 예매 시간 근처의 보조 타이머; 실제 호출 시점은 브라우저가 결정
    const FAST_CHECK_GAP_MS = 4;             // 고속 감시 구간의 최소 확인 간격
    const FAST_LEAD_MS = 3000;               // 입력한 예매 시간의 몇 ms 전부터 고속 감시를 시작할지
    const FAST_TAIL_MS = 10000;              // 예매 시간이 지난 뒤 몇 ms 까지 고속 감시를 유지할지
    const FULL_SCAN_MS = 300;                // 비싼 정밀 검사(버튼 위 덮개 확인)를 하는 주기
    const DOM_RETRY_MS = 300;                // DOM 으로 색을 못 읽는 버튼은 이 주기로만 다시 시도(그 사이엔 화면 캡처 사용)

    // 카운트다운이 끝나 글자가 바뀌어도 아래 글자(마감·종료·매진 등)면 ‘열린 상태’가 아니므로 클릭하지 않고 기다린다. 타이머 모드에서만 적용. 필요하면 여기에 추가.
    // ‘마감임박’ 은 열려 있다는 뜻일 수 있어 제외한다.
    const NOT_OPEN_TEXT = /마감(?!\s*임박)|종료|매진|품절|판매\s*불가|예매\s*불가|오픈\s*(?:예정|전)|준비\s*중|sold\s*out|closed|unavailable|coming\s*soon/i;
    const OTHER_ACTION_TEXT = /취소(?!표)|내역|조회|환불|(?:예매|예약|구매)\s*(?:확인|변경)|\bcancel\b|\brefund\b|\bhistory\b/i;
    const BOOKING_ACTION_TEXT = /^(?:(?:팬클럽\s*)?(?:선|일반)?\s*예매(?:하기)?|(?:티켓\s*)?(?:구매|예약)(?:하기)?|book(?:\s+(?:now|tickets))?|buy(?:\s+(?:now|tickets))?|reserve(?:\s+now)?)$/i;

    const INTERACTIVE = 'button, a[href], [role="button"], input[type="button"], input[type="submit"]';
    const STATE_NAME = { gray: "회색 계열", active: "유채색", waiting: "대기 기준색", changed: "색상 변화", unsupported: "읽을 수 없음" };

    // <pace-helpers>
    // "20:00", "20:00:00", "20:00:00.500" → 오늘 그 시각의 epoch ms. 비워 두면 at:0(고속 구간 없음). 형식이 틀리면 { error }.
    function parseOpenAt(text, base = new Date()) {
      const value = String(text ?? "").trim();
      if (!value) return { at: 0 };
      const m = /^(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
      const h = m ? +m[1] : NaN, min = m ? +m[2] : NaN, sec = m ? +(m[3] ?? 0) : NaN;
      if (!m || h > 23 || min > 59 || sec > 59) return { error: "예매 시간은 20:00:00 처럼 시:분:초(24시간제)로 입력하세요." };
      const d = new Date(base);
      d.setHours(h, min, sec, m[4] ? +m[4].padEnd(3, "0") : 0);
      return { at: d.getTime() };
    }
    function inFastWindow(openAt, t) { return openAt > 0 && t >= openAt - FAST_LEAD_MS && t <= openAt + FAST_TAIL_MS; }
    function fmtLeft(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
      return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s}초` : `${s}초`;
    }
    // 화면 캡처 횟수 관리: 어떤 windowMs 구간에도 max 회를 넘기지 않게 "다음 캡처까지 기다릴 ms" 를 알려 준다.
    function createQuota(windowMs, max) {
      const log = [];
      let holdUntil = 0;
      return {
        wait(now) {
          while (log.length && now - log[0] >= windowMs) log.shift();
          return Math.max(log.length >= max ? log[0] + windowMs - now : 0, holdUntil - now, 0);
        },
        note(now) { log.push(now); if (log.length > 8) log.shift(); },
        hold(now) { holdUntil = now + windowMs; },     // Chrome 이 한도 초과로 거절했을 때
      };
    }
    // </pace-helpers>
    const quota = createQuota(QUOTA_WINDOW_MS, QUOTA_MAX);

    const host = document.createElement("div");
    host.id = "booking-button-once-panel";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483647!important;color-scheme:light!important";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { position: fixed; z-index: 3; right: 18px; top: 18px; width: 330px; max-width: calc(100vw - 36px); padding: 20px; border: 1px solid #dfe1ef; border-radius: 18px; background: #fff; color: #202337; box-shadow: 0 12px 48px #171b3d30; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; }
        .panel.left { right: auto; left: 18px; }
        .panel.compact { width: 250px; padding: 40px 14px 12px; border-radius: 14px; }   /* 위쪽을 비워 ⇄ × 버튼이 상태 문구를 가리지 않게 */
        .panel.compact h2, .panel.compact .sub, .panel.compact .note, .panel.compact #target, .panel.compact #select, .panel.compact #start, .panel.compact .opt, .panel.compact .linkbtn { display: none; }
        .panel.compact .actions { margin-top: 8px; }
        h2 { margin: 0 56px 6px 0; font-size: 17px; line-height: 1.4; }
        p { margin: 0 0 12px; color: #646879; }
        button { font: inherit; font-weight: 650; cursor: pointer; border: 0; border-radius: 9px; padding: 10px 12px; background: #eef0fa; color: #252947; }
        button:disabled { opacity: .45; cursor: default; }
        button:focus-visible { outline: 3px solid #9497ff; outline-offset: 2px; }
        #close, #move { position: absolute; top: 9px; background: transparent; padding: 4px 8px; font-size: 20px; }
        #close { right: 12px; font-size: 22px; }
        #move { right: 40px; }
        .actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
        #start { background: #494dff; color: #fff; }
        #stop { background: #fff0f0; color: #a52a3e; }
        #status { padding: 12px; background: #f5f6fc; border-radius: 10px; overflow-wrap: anywhere; }
        #live { margin: 8px 0 0; font-size: 12px; color: #4b4f6b; }
        #live:empty { display: none; }
        #swatches { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 0; font-size: 12px; color: #4b4f6b; }
        .chip { display: inline-flex; align-items: center; gap: 6px; }
        .chip i { flex: none; width: 22px; height: 22px; border-radius: 6px; border: 1px solid #1f23412e; background: transparent; }
        #target { margin: 9px 0 0; font-size: 12px; overflow-wrap: anywhere; }
        .note { margin: 12px 0 0; font-size: 11px; color: #646879; }
        .note summary { cursor: pointer; font-weight: 650; color: #4b4f6b; }
        .note summary:focus-visible { outline: 3px solid #9497ff; outline-offset: 2px; border-radius: 4px; }
        .note p { margin: 6px 0 0; font-size: 11px; }
        .linkbtn { display: block; margin: 8px 0 0; padding: 0; background: none; color: #494dff; font-size: 12px; font-weight: 600; text-align: left; text-decoration: underline; }
        .opt { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 12px; color: #4b4f6b; cursor: pointer; }
        .opt input { margin: 0; accent-color: #494dff; }
        #trigger { min-width: 0; flex: 1; padding: 5px; border: 1px solid #dfe1ef; border-radius: 7px; background: #fff; color: #202337; font: inherit; }
        .opt.time { flex-wrap: wrap; cursor: default; }
        .opt.sound { flex-wrap: wrap; cursor: default; }
        .opt.sound label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .opt .linkbtn { display: inline; margin: 0 0 0 2px; }
        #openAt { width: 96px; padding: 5px 8px; border: 1px solid #dfe1ef; border-radius: 7px; background: #fff; color: #202337; font: inherit; font-size: 12px; }
        #openAt:focus-visible { outline: 3px solid #9497ff; outline-offset: 1px; }
        #openAt:disabled { opacity: .45; }
        #picker { position: fixed; z-index: 1; inset: 0; cursor: crosshair; background: #494dff08; touch-action: none; }
        #outline { position: fixed; z-index: 2; border: 3px solid #494dff; border-radius: 7px; pointer-events: none; }
        [hidden] { display: none !important; }
      </style>
      <div id="picker" hidden></div><div id="outline" hidden></div>
      <section class="panel" id="panel" aria-label="예매 버튼 감시">
        <button id="move" aria-label="패널 위치를 좌우로 바꾸기" title="패널 위치 바꾸기">⇄</button>
        <button id="close" aria-label="감시 중지 및 패널 닫기">×</button>
        <h2 id="title">예매 버튼 한 번 클릭</h2>
        <p class="sub" id="sub">비활성 → 활성 상태 · 색상 변화 대기 없이 1회 클릭</p>
        <div id="status" role="status" aria-live="polite">① 버튼 선택 → ② 대기 중인 예매 버튼 지정 → ③ 감시 시작</div>
        <p id="live"></p>
        <div id="swatches" hidden><span class="chip" id="swBaseWrap" hidden><i id="swBase"></i>대기 기준</span><span class="chip"><i id="swNow"></i><span id="swNowText">현재</span></span></div>
        <p id="target">선택한 버튼이 없습니다.</p>
        <label class="opt">감지 기준 <select id="trigger"><option value="state">활성 상태 변화 (DOM)</option><option value="color">색상 변화 (기존 방식)</option></select></label>
        <label class="opt"><input type="checkbox" id="force"> 화면 색으로만 판단 (자동 감지가 안 맞을 때)</label>
        <label class="opt" title="이미지 버튼이 바뀔 때 페이지에 알림(클래스·이미지 교체 등)이 없는 경우에만 켜세요. 화면 캡처를 약 0.55초마다 확인해 변화를 놓치지 않지만, 알림이 있는 이미지 버튼은 기본 설정보다 느려집니다."><input type="checkbox" id="cadence"> 캔버스·영상 버튼 (바뀔 때 알림이 없는 이미지)</label>
        <div class="opt sound"><label><input type="checkbox" id="sound" checked> 알림음 (클릭 = 높은 두 음 · 중단 = 낮은 세 음)</label><button class="linkbtn" id="soundTest" type="button">미리 듣기</button></div>
        <label class="opt time" title="버튼 변경은 즉시 확인합니다. 이 시각 3초 전부터 10초 후까지 보조 확인을 더 자주 합니다.">예매 시간(선택) <input type="text" id="openAt" inputmode="numeric" placeholder="20:00:00" maxlength="12" autocomplete="off" spellcheck="false"></label>
        <button class="linkbtn" id="frames">버튼이 프레임(iframe) 안에 있나요? 프레임 안 패널 열기</button>
        <div class="actions">
          <button id="select">버튼 선택</button>
          <button id="start" disabled>감시 시작</button>
          <button id="stop" disabled>중지</button>
        </div>
        <details class="note"><summary>사용 안내 보기</summary><p>기본 DOM 모드는 disabled·aria-disabled·inert 등으로 비활성인 버튼을 지정해 시작합니다. 활성 상태로 바뀌면 색상이나 화면 캡처를 기다리지 않고 1회 클릭합니다. 같은 자리의 새 예매 버튼으로 교체되는 경우도 확인합니다. 처음부터 활성인 버튼이나 색으로만 대기를 표시하는 버튼은 ‘색상 변화’를 선택하세요. 기존 색상 모드에서는 대기 기준색에서 충분히 달라져야 클릭하며, 이미지 버튼의 보조 캡처와 ‘화면 색으로만 판단’도 사용할 수 있습니다. 이 탭을 앞에 열고, 패널이 버튼을 가리면 ⇄ 로 옮기세요. 예매 시간은 강제 클릭 예약이 아닌 보조 확인 설정입니다. Esc로 중지, 최대 1시간 감시, 새로고침하면 다시 설정해야 합니다.</p></details>
      </section>`;
    document.documentElement.append(host);
    const ui = Object.fromEntries(["picker", "outline", "panel", "title", "sub", "status", "live", "target", "trigger", "force", "cadence", "sound", "soundTest", "swatches", "swBaseWrap", "swBase", "swNow", "swNowText", "openAt", "frames", "select", "start", "stop", "close", "move"].map(id => [id, root.getElementById(id)]));

    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = colorCanvas.height = 1;
    const ctx = colorCanvas.getContext("2d", { willReadFrequently: true });
    const colorCache = new Map();

    let target = null;
    let fp = null;               // 선택한 버튼의 "지문" (재렌더링 시 같은 버튼을 다시 찾는 데 사용)
    let fpAt = 0;
    let selecting = false;
    let watching = false;
    let fired = false;
    let timer = 0;
    let scheduled = 0;           // 합쳐 둔 다음 확인(setTimeout id)
    let lastCheckAt = 0;
    let lastFullAt = 0;
    let domBlockedUntil = 0;     // 이 시각까지는 DOM 색 읽기를 건너뜀(이미 못 읽는 것으로 확인된 버튼)
    let domBlockedEl = null;
    let observer = null;
    let runKey = "";
    let lastMessage = "";
    let lastLive = "";
    let lastRGB = null;          // 마지막으로 읽은 현재 색(색 견본용)
    let lastSwatch = "";
    let lostSince = null;
    let lastSearch = 0;
    let unreadableSince = null;
    let deadline = 0;
    let moveQueued = false;
    let mode = "state";          // state: DOM 비활성→활성 / color: 색 변화 / timer: 카운트다운
    let stateAnchor = null;       // DOM 모드에서 처음 비활성이던 버튼의 자리와 살아 있는 부모들
    let forcePixel = false;      // true: DOM 은 보지 않고 화면 캡처 색만 사용
    let baseline = null;         // 시작할 때 실제로 읽은 대기색; 재렌더링 중에도 유지
    let operation = 0;          // 중지 후 도착한 비동기 색 확인 결과가 다시 시작하지 않게 한다
    let starting = false;        // 선택/시작 직후 색을 확인하는 동안
    let pixel = null;            // 마지막 화면 캡처 결과 { el, state, rgb, at } 또는 { el, error, at }
    let pixelBusy = false;
    let pixelLast = 0;           // 마지막 화면 캡처를 시작한 시각
    let pixelEvery = PIXEL_EVENT_FIRST_MS;   // 이번 감시의 평소 화면 캡처 주기
    let burstUntil = 0;          // 이 시각까지는 변화 신호를 받은 상태 → 캡처 주기를 기다리지 않음
    let openAt = 0;              // 입력한 예매 시간(epoch ms). 0 이면 고속 감시 구간 없음
    let fastNow = false;         // 지금 고속 감시 구간인지
    let frameId = 0;             // 화면 프레임에 맞춘 확인 루프(requestAnimationFrame)
    let lastFrameAt = 0;

    const pageKey = () => location.origin + location.pathname;   // ?쿼리, #해시 변경은 무시

    // ── UI ────────────────────────────────────────────────────────
    function status(message) {
      if (lastMessage !== message) { lastMessage = message; ui.status.textContent = message; }
    }
    function setLive(color) {
      if (ui.trigger.value === "state") {
        lastRGB = null;
        paintSwatches();
        const text = color ? `현재 상태: ${color.state === "active" ? "활성 (클릭 가능)" : "비활성 (대기)"} · DOM 직접 확인` : "";
        if (text !== lastLive) { lastLive = text; ui.live.textContent = text; }
        return;
      }
      lastRGB = color && typeof color === "object" && Array.isArray(color.rgb) ? color.rgb : null;
      paintSwatches();
      const text = typeof color === "string" ? color
        : color ? `현재 감지: ${!watching && color.state !== "unsupported" ? "읽은 색" : STATE_NAME[watching && mode === "color" && baseline && color.state !== "unsupported" ? (activationChanged(color) ? "changed" : "waiting") : color.state]}${color.rgb ? ` · rgb(${color.rgb.join(", ")})` : ""}${color.via === "pixel" && color.rgb ? " · 화면 캡처" : ""}` : "";
      if (text !== lastLive) { lastLive = text; ui.live.textContent = text; }
    }
    // 기준색(감시 시작 순간에 기억한 색)과 현재 색을 색 견본으로 보여 준다.
    // 시작 전에는 ‘지금 색’만 보여 주므로, 버튼이 대기 상태일 때 시작하는지 눈으로 확인할 수 있다.
    function paintSwatches() {
      if (ui.trigger.value === "state") { ui.swatches.hidden = true; return; }
      const base = watching && mode === "color" && baseline ? baseline.rgb : null;
      const now = lastRGB;
      const key = `${base}|${now}|${watching}`;
      if (key === lastSwatch) return;
      lastSwatch = key;
      const css = c => `rgb(${c.join(",")})`;
      ui.swatches.hidden = !base && !now;
      ui.swBaseWrap.hidden = !base;
      if (base) ui.swBase.style.background = css(base);
      ui.swNow.style.background = now ? css(now) : "transparent";
      ui.swNowText.textContent = watching ? "현재" : "지금 색 · 시작하면 이 색을 대기 기준으로 기억";
    }

    // ── 알림음 ────────────────────────────────────────────────────
    // 소리를 내려면 사용자 동작(‘감시 시작’ 클릭) 안에서 AudioContext 를 만들어 둬야 한다(브라우저 자동 재생 제한).
    // 클릭을 보냈을 때 = 높고 짧게 올라가는 두 음, 감시가 저절로 멈췄을 때 = 낮게 내려가는 세 음. 화면을 안 봐도 구분된다.
    // 사용자가 직접 중지(Esc·중지 버튼·닫기)한 경우에는 울리지 않는다.
    const SOUNDS = {
      fired:   { wave: "sine",     notes: [[880, 0, .12], [1320, .14, .22]] },
      stopped: { wave: "triangle", notes: [[330, 0, .22], [262, .26, .22], [196, .52, .4]] },
    };
    let audio = null;
    function prepareAudio() {
      try {
        audio ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
        if (audio.state === "suspended") audio.resume().catch(() => {});
      } catch { audio = null; }
    }
    function playSound(name, force = false) {
      if (!audio || (!force && !ui.sound.checked)) return;
      try {
        if (audio.state === "suspended") audio.resume().catch(() => {});
        const { wave, notes } = SOUNDS[name];
        const t0 = audio.currentTime + 0.02;
        for (const [freq, at, len] of notes) {
          const osc = audio.createOscillator(), gain = audio.createGain();
          osc.type = wave;
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + at);
          gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
          osc.connect(gain).connect(audio.destination);
          osc.start(t0 + at);
          osc.stop(t0 + at + len + 0.02);
        }
      } catch { /* 소리가 안 나도 감시에는 영향 없음 */ }
    }

    // 패널이 선택한 버튼을 가리면 반대쪽(오른쪽↔왼쪽)으로 옮긴다. 양쪽 모두 가리면(버튼이 화면 가득한 경우) 그대로 둔다.
    // 버튼을 고른 직후와 감시를 시작한 직후(패널이 작아진 뒤)에 확인한다.
    function avoidTarget() {
      if (!target?.isConnected) return;
      const t = target.getBoundingClientRect();
      if (!t.width || !t.height) return;
      const covered = () => {
        const p = ui.panel.getBoundingClientRect();
        return p.left < t.right && p.right > t.left && p.top < t.bottom && p.bottom > t.top;
      };
      if (!covered()) return;
      ui.panel.classList.toggle("left");
      if (covered()) ui.panel.classList.toggle("left");
    }

    function syncControls() {
      ui.select.disabled = watching || starting;
      ui.trigger.disabled = watching || starting || selecting;
      ui.force.disabled = watching || starting || ui.trigger.value === "state";
      ui.cadence.disabled = watching || starting || ui.trigger.value === "state";
      ui.openAt.disabled = watching || starting;
      ui.frames.disabled = watching || starting;
      ui.start.disabled = !target || watching || selecting || starting;
      ui.stop.disabled = !watching && !selecting && !starting;
      ui.panel.classList.toggle("compact", watching);   // 감시 중에는 패널을 작게
      paintSwatches();
    }
    function clearWatch() {
      operation++;
      watching = false;
      baseline = null;
      stateAnchor = null;
      clearInterval(timer);
      clearTimeout(scheduled);
      cancelAnimationFrame(frameId); frameId = 0;
      timer = 0; scheduled = 0;
      observer?.disconnect();
      observer = null;
      for (const type of VISUAL_EVENTS) document.removeEventListener(type, onVisualEvent, true);
      openAt = 0; fastNow = false; burstUntil = 0; lastRGB = null;
    }
    function stop(message = "중지했습니다. 다시 감시하려면 대기 상태에서 시작하세요.", alert = false) {   // alert: 저절로 멈춘 경우 알림음
      clearWatch();
      selecting = false;
      ui.picker.hidden = true;
      ui.outline.hidden = true;
      syncControls();
      status(message);
      if (alert) playSound("stopped");
    }

    // ── 요소 유틸 ─────────────────────────────────────────────────
    function visible(el) {
      if (!el?.isConnected || !el.getClientRects().length) return false;
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) < 0.05 || p.hidden) return false;
      }
      return true;
    }
    function label(el) {
      return (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 140);
    }
    function rectContains(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    function outline(el) {
      if (!el?.isConnected) { ui.outline.hidden = true; return; }
      const r = el.getBoundingClientRect();
      Object.assign(ui.outline.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      ui.outline.hidden = false;
    }

    // ── 색 판별 ───────────────────────────────────────────────────
    function rgba(css) {
      if (colorCache.has(css)) return colorCache.get(css);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";   // 해석할 수 없는 값이면 이전 색이 남는 것을 방지
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const result = [...ctx.getImageData(0, 0, 1, 1).data];
      if (colorCache.size > 256) colorCache.clear();
      colorCache.set(css, result);
      return result;
    }
    // 색상 종류나 밝기를 제한하지 않는다. 이 분류만으로 활성 여부를 정하지는 않는다.
    // 파랑·보라·분홍·빨강·주황·노랑·초록·청록 모두 같은 기준을 사용한다.
    function classify([r, g, b]) {
      if (![r, g, b].every(Number.isFinite)) return "unsupported";
      return Math.max(r, g, b) - Math.min(r, g, b) <= 32 ? "gray" : "active";
    }
    // 연한 회청색도 대기색일 수 있다. 고정된 색상 대신 시작 시점의 색과 비교한다.
    function colorChanged(rgb, reference) {
      if (!rgb || !reference || rgb.length !== 3 || reference.length !== 3) return false;
      const delta = rgb.map((v, i) => Math.abs(v - reference[i]));
      // 미세한 안티앨리어싱/색 흔들림은 무시하고, 검정/흰색 등 무채색 변화도 제외한다.
      return classify(rgb) === "active" && Math.max(...delta) >= 24 &&
        delta.reduce((sum, d) => sum + d * d, 0) >= 900;
    }
    function samePaint(a, b) {
      return !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 12);
    }
    function activationChanged(color) {
      if (!baseline || !colorChanged(color.rgb, baseline.rgb)) return false;
      // 버튼 밖의 덮개만 색이 바뀐 경우를 활성화로 보지 않는다.
      if (color.ownRGB && baseline.ownRGB && !colorChanged(color.ownRGB, baseline.ownRGB)) {
        // 회색/회청색 대기 덮개가 사라져 원래 버튼색이 드러나는 방식도 지원한다.
        return !samePaint(baseline.rgb, baseline.ownRGB) &&
          samePaint(color.rgb, color.ownRGB);
      }
      return true;
    }
    // ── 색 읽기: 화면에 "실제로 보이는" 색 (반투명 배경은 뒤 배경과 합성) ──
    const COLOR_FN = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)/g;
    const isTimerText = t => /^\d{1,3}(\s*[:：]\s*\d{1,2}){1,2}$/.test(t.trim());   // 00:02, 1:05:30 ...

    // 한 요소가 칠하는 면: { c:[r,g,b], a:0~1 }. 그라데이션은 평균색. 칠한 게 없으면 null.
    function paintOf(style, opacity) {
      const img = style.backgroundImage;
      let colors = null;
      if (img && img !== "none" && img.includes("gradient")) {
        const stops = (img.match(COLOR_FN) || []).map(rgba);
        if (stops.length) colors = stops;
      }
      colors ??= [rgba(style.backgroundColor)];
      let wa = 0, r = 0, g = 0, b = 0;
      for (const c of colors) { const a = c[3] / 255; wa += a; r += c[0] * a; g += c[1] * a; b += c[2] * a; }
      const a = wa / colors.length * opacity;
      return wa < 0.01 || a < 0.02 ? null : { c: [r / wa, g / wa, b / wa], a };
    }
    // ::before / ::after 로 버튼 면을 칠하는 사이트
    function pseudoPaints(el, box, opacity) {
      const out = [];
      for (const which of ["::before", "::after"]) {
        const s = getComputedStyle(el, which);
        if (s.content === "none" || s.content === "normal" || s.display === "none") continue;
        if (!(parseFloat(s.width) >= box.width * .8 && parseFloat(s.height) >= box.height * .7)) continue;
        const p = paintOf(s, opacity * Number(s.opacity));
        if (p) out.push(p);
      }
      return out;
    }
    function cumulativeOpacity(el) {
      let o = 1;
      for (let p = el; p; p = p.parentElement) o *= Number(getComputedStyle(p).opacity);
      return o;
    }
    function blend(back, layers) {
      let c = [255, 255, 255];
      for (const l of [...back, ...layers]) c = c.map((v, i) => v * (1 - l.a) + l.c[i] * l.a);
      return c;
    }
    // full=false: 버튼 자신의 면만으로 판정하는 가벼운 경로(활성 색상 후보일 때만 덮개 검사를 이어서 한다).
    function readColor(el, full = true) {
      const box = el.getBoundingClientRect();
      const chain = [];
      for (let p = el; p; p = p.parentElement) chain.push(p);            // el → html
      const styles = chain.map(p => getComputedStyle(p));
      const cum = [];                                                      // 위(root)에서부터 누적한 opacity
      for (let i = chain.length - 1, acc = 1; i >= 0; i--) { acc *= Number(styles[i].opacity); cum[i] = acc; }

      // 버튼과 거의 같은 크기의 바깥 래퍼(최대 3단계)는 버튼의 일부로 본다
      let own = 0;
      for (let i = 1; i <= 3 && i < chain.length; i++) {
        const p = chain[i];
        if (p === document.body || p === document.documentElement) break;
        const r = p.getBoundingClientRect();
        if (r.width > box.width * 1.35 + 8 || r.height > box.height * 1.35 + 8) break;
        own = i;
      }
      // 버튼 뒤에 깔린 배경: 가까운 조상부터, 불투명한 면을 만날 때까지만
      const back = [];
      for (let i = own + 1, clear = 1; i < chain.length && clear > 0.005; i++) {
        const p = paintOf(styles[i], cum[i]);
        if (p) { back.push(p); clear *= 1 - p.a; }
      }
      back.reverse();

      // 버튼 자신이 그리는 면 (아래 → 위)
      const layers = [];
      let imageHint = false;
      for (let i = own; i >= 0; i--) {
        const p = paintOf(styles[i], cum[i]);
        if (p) layers.push(p);
        if (styles[i].backgroundImage.includes("url(")) imageHint = true;
        layers.push(...pseudoPaints(chain[i], box, cum[i]));
      }
      for (const d of [...el.querySelectorAll("*")].slice(0, 40)) {
        const r = d.getBoundingClientRect();
        if (r.width < box.width * .8 || r.height < box.height * .7) continue;
        const s = getComputedStyle(d);
        const p = paintOf(s, cum[0] * Number(s.opacity));
        if (p) layers.push(p);
        if (s.backgroundImage.includes("url(") || /^(img|svg|canvas|video)$/i.test(d.localName)) imageHint = true;
        layers.push(...pseudoPaints(d, box, cum[0]));
      }
      if (!layers.length) {
        return { state: "unsupported", rgb: null, reason: imageHint ? "이미지로 그려진 버튼" : "버튼 자체에 배경색이 없음(투명)" };
      }
      const ownRGB = blend(back, layers).map(Math.round);
      const ownState = classify(ownRGB);
      // 시작할 때 덮개가 있었다면 버튼색이 그대로여도 덮개의 제거 여부를 확인한다.
      const unchangedUnmasked = baseline?.ownRGB && samePaint(baseline.rgb, baseline.ownRGB) &&
        !colorChanged(ownRGB, baseline.ownRGB);
      if (!full && (ownState !== "active" || unchangedUnmasked)) return { state: ownState, rgb: ownRGB, ownRGB };
      // 버튼 위에 얹힌 반투명 요소(겹친 오버레이). pointer-events:none 인 덮개는 좌표 검사로 안 잡히므로 형제 요소를 직접 본다.
      const seen = new Set();
      for (let i = 0; i <= own; i++) {
        const parent = chain[i].parentElement;
        if (!parent) continue;
        let after = false, scanned = 0;
        for (const sib of parent.children) {
          if (sib === chain[i]) { after = true; continue; }
          if (!after || sib === host || ++scanned > 50) continue;
          const s = getComputedStyle(sib);
          if (s.position === "static" || s.display === "none" || parseInt(s.zIndex, 10) < 0) continue;
          const r = sib.getBoundingClientRect();
          if (r.width < box.width * .8 || r.height < box.height * .7 || r.left > box.right || r.right < box.left || r.top > box.bottom || r.bottom < box.top) continue;
          const p = paintOf(s, cumulativeOpacity(sib));
          if (p) { layers.push(p); seen.add(sib); }
        }
      }
      const cx = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
      const stack = document.elementsFromPoint(cx, cy);
      const at = stack.indexOf(el);
      if (at > 0) {
        for (const o of stack.slice(0, at).reverse()) {
          if (o === host || el.contains(o) || seen.has(o)) continue;
          const p = paintOf(getComputedStyle(o), cumulativeOpacity(o));
          if (p) layers.push(p);
        }
      }
      const rgb = blend(back, layers).map(Math.round);
      // 외부의 색 있는 덮개가 회색 버튼을 활성 색상으로 바꾼 것처럼 보이면 기다린다.
      return ownState === "active" ? { state: classify(rgb), rgb, ownRGB } : { state: ownState, rgb: ownRGB, ownRGB };
    }

    // ── 화면 픽셀로 색 읽기 ─────────────────────────────────────────
    // DOM 에서 색을 못 읽는 버튼(이미지·캔버스·SVG·특수 효과)은 service worker 가 탭을 캡처해 주면
    // 버튼 위 여러 지점의 실제 화면 색(중앙값)으로 판단한다. 글자(흰색) 같은 소수 픽셀은 중앙값이 걸러 준다.
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // <pixel-helpers>
    const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
    const dominantColor = samples => samples.length ? [0, 1, 2].map(i => median(samples.map(c => c[i]))) : null;
    function gridPoints(left, top, right, bottom) {   // 둥근 모서리는 피하고 가로 7 × 세로 3 지점
      const points = [];
      for (const fy of [.3, .5, .7]) for (const fx of [.12, .22, .32, .5, .68, .78, .88]) points.push([left + (right - left) * fx, top + (bottom - top) * fy]);
      return points;
    }
    // </pixel-helpers>
    // 버튼 안에서 실제로 보이는 지점들. 우리 패널이 덮은 곳은 제외한다.
    function visiblePoints(el) {
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (right - left < 6 || bottom - top < 6) return { points: [], why: "버튼이 화면 안에 보이지 않습니다. 스크롤해서 버튼이 보이게 하세요." };
      const strict = [], loose = [];
      for (const point of gridPoints(left, top, right, bottom)) {
        const hit = document.elementFromPoint(point[0], point[1]);
        if (!hit || hit === host || host.contains(hit)) continue;
        (hit === el || el.contains(hit) || hit.contains(el) ? strict : loose).push(point);
      }
      return { points: strict.length >= 3 ? strict : [...strict, ...loose], why: "패널이 버튼을 가리고 있습니다. ⇄ 로 패널을 옮기세요." };
    }
    // 한 번 캡처해서 색을 읽는다. 절대 throw 하지 않고 { state, rgb } | { error, hiddenTab? } | { retry } 를 돌려준다.
    async function capture(el) {
      try {
        if (document.hidden) return { hiddenTab: true, error: "이 탭이 가려져 있습니다. 이 탭을 앞으로 가져오면 화면 색을 읽습니다." };
        const { points, why } = visiblePoints(el);
        if (!points.length) return { error: why };
        const off = await bridge.frameOffset();      // 최상위 프레임이면 (0,0). 프레임 안이면 상위 프레임이 알려 준 위치
        if (!off) return { error: "이 프레임이 화면에서 어디에 있는지 알 수 없어 화면 캡처로 읽을 수 없습니다. (상위 프레임에도 확장프로그램이 열려 있어야 합니다)" };
        const shown = points.map(([x, y]) => [x + off.x, y + off.y]).filter(([x, y]) => x >= 0 && y >= 0 && x < off.topW && y < off.topH);
        if (!shown.length) return { error: "버튼이 화면 밖에 있습니다. 스크롤해서 버튼이 보이게 하세요." };
        let reply;
        quota.note(performance.now());
        try { reply = await chrome.runtime.sendMessage({ type: "booking-sample", points: shown, vw: off.topW, vh: off.topH }); }
        catch { return { error: "확장프로그램과 연결이 끊겼습니다. 페이지를 새로고침한 뒤 확장프로그램 아이콘으로 다시 여세요." }; }
        if (!reply) return { error: "화면 캡처 응답이 없습니다. chrome://extensions 에서 확장프로그램을 새로고침한 뒤 페이지도 새로고침하세요." };
        if (reply.code === "quota") { quota.hold(performance.now()); return { retry: true }; }
        if (reply.code === "inactive") return { hiddenTab: true, error: "이 탭이 앞에 보이지 않아 화면 색을 읽을 수 없습니다." };
        if (reply.code === "permission") return { error: "화면 캡처 권한이 없습니다. 확장프로그램 아이콘을 누르고 ‘이 페이지에서 열기’를 한 번 더 누르세요." };
        if (reply.error || !Array.isArray(reply.colors) || !reply.colors.length) return { error: `화면 캡처에 실패했습니다${reply.error ? ` (${reply.error})` : ""}.` };
        const rgb = dominantColor(reply.colors);
        return { state: classify(rgb), rgb };
      } catch (error) {
        return { error: `화면 색을 읽는 중 오류가 발생했습니다 (${error?.message ?? error}).` };
      }
    }
    // 감시 루프용: 캡처를 (간격을 두고) 백그라운드로 요청해 두고, 마지막 결과를 쓴다.
    // 버튼 근처(버튼 자신·안쪽·바로 바깥 래퍼)가 바뀌었다는 신호. 이 상태에서는 캡처 주기를 기다리지 않는다.
    function nearTarget(node) {
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      if (!el || !target) return false;
      if (el === target || target.contains(el)) return true;
      return el.contains(target) && el !== document.body && el !== document.documentElement;
    }
    function kickPixel(now) {
      if (mode !== "color" || !(forcePixel || domBlockedEl === target)) return;   // DOM 으로 색을 읽는 버튼에는 필요 없음
      burstUntil = now + PIXEL_BURST_MS;
    }
    const VISUAL_EVENTS = ["load", "transitionrun", "transitionend", "animationstart", "animationend"];   // 이미지가 다 불러와졌거나 색 전환이 끝난 순간
    function onVisualEvent(event) {
      if (!watching || !nearTarget(event.target)) return;
      domBlockedUntil = 0;
      kickPixel(performance.now());
      immediateCheck();
    }
    // 변화가 화면에 그려진 직후에 캡처하려고 한 프레임 기다린다(최대 60ms. 가려진 탭에서는 타이머가 대신 풀어 준다).
    const afterPaint = () => new Promise(resolve => {
      const fallback = setTimeout(resolve, 60);
      requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); resolve(); }, 0));
    });
    function requestPixel(now) {
      if (!watching || pixelBusy || quota.wait(now) > 0) return;
      const burst = now < burstUntil;
      if (!burst && now - pixelLast < pixelEvery) return;
      pixelBusy = true;
      pixelLast = now;
      const el = target;
      const ticket = operation;
      (burst ? afterPaint() : Promise.resolve()).then(() => {
        if (!watching || ticket !== operation || el !== target) return { cancelled: true };
        return capture(el);
      }).then(result => {
        pixelBusy = false;
        if (result.cancelled || ticket !== operation || !watching || el !== target || result.retry) return;
        pixel = { el, ...result, at: performance.now() };
        immediateCheck();
      });
    }
    // 감시 루프용(동기): DOM 으로 읽을 수 있으면 DOM, 아니면 최근 화면 캡처 결과.
    function currentColor(now) {
      if (!forcePixel && !(domBlockedEl === target && now < domBlockedUntil)) {
        const full = now - lastFullAt >= FULL_SCAN_MS;
        if (full) lastFullAt = now;
        const dom = readColor(target, full);
        if (dom.state !== "unsupported") { domBlockedEl = null; return { ...dom, via: "dom" }; }
        domBlockedEl = target;
        domBlockedUntil = now + DOM_RETRY_MS;
      }
      requestPixel(now);
      if (pixel?.el === target && now - pixel.at <= PIXEL_FRESH_MS) {
        if (pixel.error) return { state: "unsupported", rgb: null, reason: pixel.error, via: "pixel", hiddenTab: !!pixel.hiddenTab };
        return { state: pixel.state, rgb: pixel.rgb, via: "pixel" };
      }
      return { state: "unsupported", rgb: null, reason: "화면 색을 읽는 중입니다.", via: "pixel", pending: true };
    }
    // 선택/시작 직후용(비동기): DOM 먼저, 안 되면 화면 캡처를 한 번 수행한다.
    async function readNow(el) {
      if (ui.trigger.value === "state") return { state: enabled(el) ? "active" : "waiting", rgb: null, via: "state" };
      if (!forcePixel) {
        const dom = readColor(el);
        if (dom.state !== "unsupported") return { ...dom, via: "dom" };
      }
      let result = { error: "화면 캡처에 실패했습니다." };
      for (let attempt = 0; attempt < 3; attempt++) {
        while (pixelBusy) await sleep(60);
        const wait = quota.wait(performance.now());
        if (wait > 0) await sleep(wait);
        pixelBusy = true;
        pixelLast = performance.now();
        try { result = await capture(el); }
        finally { pixelBusy = false; }
        if (!result.retry) break;
      }
      if (result.retry) result = { error: "화면 캡처가 너무 잦아 잠시 거절됐습니다. 잠시 뒤 다시 시도하세요." };
      if (result.error) return { state: "unsupported", rgb: null, reason: result.error, via: "pixel" };
      pixel = { el, ...result, at: performance.now() };
      return { state: result.state, rgb: result.rgb, via: "pixel" };
    }

    // ── 버튼 선택 ─────────────────────────────────────────────────
    function findAt(x, y) {
      ui.picker.hidden = true;
      const hit = document.elementFromPoint(x, y);
      ui.picker.hidden = false;
      if (!hit || hit === host) return null;
      const bounded = r => r.width >= 40 && r.height >= 18 && r.width <= 900 && r.height <= 300;
      const area = el => { const r = el.getBoundingClientRect(); return r.width * r.height; };
      // 1) 클릭한 곳에서 위로 올라가며: 버튼 태그 / cursor:pointer 를 직접 지정한 요소(강한 후보),
      //    글자가 있고 배경이 직접 칠해진 요소(약한 후보 — div 로 만든 버튼). 약한 후보가 훨씬 작으면 그쪽이 진짜 버튼.
      let weak = null;
      for (let el = hit, n = 0; el && n < 6; n++, el = el.parentElement) {
        if (el === document.body || el === document.documentElement || el.tagName === "IFRAME") break;
        if (!bounded(el.getBoundingClientRect())) continue;
        const s = getComputedStyle(el);
        const ownPointer = s.cursor === "pointer" && getComputedStyle(el.parentElement ?? el).cursor !== "pointer";
        if (el.matches(INTERACTIVE) || ownPointer) return weak && area(weak) < area(el) * .6 ? weak : el;
        if (!weak && label(el) && (paintOf(s, 1) || s.backgroundImage.includes("url(") || pseudoPaints(el, el.getBoundingClientRect(), 1).length)) weak = el;
      }
      // 2) pointer-events:none 인 비활성 버튼은 클릭 대상으로 안 잡히므로 좌표로 찾는다
      const geo = [...document.querySelectorAll(INTERACTIVE)].filter(el => {
        const r = el.getBoundingClientRect();
        return bounded(r) && visible(el) && rectContains(r, x, y);
      }).sort((a, b) => area(a) - area(b))[0];
      if (geo && weak) return area(geo) < area(weak) ? geo : weak;
      return geo ?? weak;
    }
    async function pick(event) {
      event.preventDefault();
      event.stopPropagation();
      const el = findAt(event.clientX, event.clientY);
      if (!el) {
        ui.picker.hidden = true;
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        ui.picker.hidden = false;
        status(hit && /^i?frame$/i.test(hit.tagName)
          ? "이 영역은 프레임(iframe) 안입니다. Esc로 선택을 취소하고 아래 ‘프레임 안 패널 열기’를 누른 뒤, 프레임 안에 열린 패널에서 버튼을 선택하세요."
          : "버튼을 찾지 못했습니다. 대기 중인 예매 버튼의 가운데를 선택하세요. (패널 아래에 있으면 ⇄ 로 패널을 옮기세요.)");
        return;
      }
      const ticket = ++operation;
      target = el;
      fp = makeFingerprint(el, performance.now());
      pixel = null;
      selecting = false;
      starting = true;
      ui.picker.hidden = true;
      ui.outline.hidden = true;
      ui.target.textContent = `선택: ${label(el) || el.tagName.toLowerCase()}`;
      syncControls();
      status(ui.trigger.value === "state" ? "선택했습니다. 버튼의 활성 상태를 확인하는 중입니다…" : "선택했습니다. 버튼 색을 확인하는 중입니다…");
      let color;
      try { color = await readNow(el); }
      catch (error) { color = { state: "unsupported", rgb: null, reason: `오류: ${error?.message ?? error}` }; }
      finally { starting = false; syncControls(); }
      if (ticket !== operation || el !== target) return;
      setLive(color);
      syncControls();
      avoidTarget();
      status(color.via === "state" ? (color.state === "active"
        ? "선택한 버튼은 이미 활성 상태입니다. DOM 모드는 비활성 버튼에서 시작하세요. 색으로만 대기를 표시하면 ‘색상 변화’를 선택하세요."
        : "비활성 버튼을 선택했습니다. ‘감시 시작’을 누르면 활성 상태로 바뀌는 즉시 1회 클릭합니다.")
        : color.state !== "unsupported" ? `선택했습니다${color.via === "pixel" ? " (화면 캡처로 색을 읽습니다)" : ""}. 버튼이 대기 상태일 때 ‘감시 시작’을 누르면 현재 색을 대기 기준으로 기억합니다.`
        : isTimerText(label(el)) ? `색은 읽을 수 없지만(${color.reason}) 카운트다운 버튼이라 ‘숫자가 끝나고 글자가 바뀌는 순간’을 감시할 수 있습니다. ‘감시 시작’을 누르세요.`
        : `이 버튼의 색을 읽을 수 없습니다 (${color.reason}) 같은 버튼의 색이 칠해진 다른 부분을 다시 선택해 보세요.`);
    }

    // ── 재렌더링 대응: 버튼 지문 + 대체 버튼 찾기 ─────────────────
    const STATE_CLASS = /(^|[-_])(active|disabled|enabled|on|off|hover|focus|selected|loading|blue|purple|violet|red|green|orange|yellow|pink|cyan|gray|grey)([-_]|$)/i;
    function makeFingerprint(el, now) {
      const r = el.getBoundingClientRect();
      fpAt = now;
      return {
        id: el.id, tag: el.tagName, text: label(el),
        classes: [...el.classList].filter(c => !STATE_CLASS.test(c)),
        cx: r.left + scrollX + r.width / 2, cy: r.top + scrollY + r.height / 2, w: r.width, h: r.height,
      };
    }
    function refreshFingerprint(el, now) {
      if (now - fpAt < 400) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      fp = makeFingerprint(el, now);
    }
    function bigrams(s) {
      const out = new Set();
      for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
      return out;
    }
    function textScore(a, b) {
      if (a === b) return 2;
      const x = bigrams(a);
      for (const g of bigrams(b)) if (x.has(g)) return 1;
      return 0;
    }
    // DOM 상태 모드는 클래스·문구가 완전히 다른 버튼으로 교체될 수 있다.
    // 처음 지정한 부모 영역과 자리를 함께 기억한다. 페이지 전체에서 '예매하기'만 찾아 누르지 않는다.
    function rememberStateSlot(el) {
      const scopes = [];
      for (let p = el.parentElement; p && p !== document.documentElement && scopes.length < 6; p = p.parentElement) scopes.push(p);
      const r = el.getBoundingClientRect();
      return { scopes, id: el.id, text: label(el),
        cx: r.left + scrollX + r.width / 2, cy: r.top + scrollY + r.height / 2, w: r.width, h: r.height };
    }
    function stateScope() {
      return stateAnchor?.scopes.find(el => el.isConnected) ?? null;
    }
    function resolveStateTarget(now) {
      if (target.isConnected && visible(target)) {
        lostSince = null;
        const r = target.getBoundingClientRect();
        Object.assign(stateAnchor, { cx: r.left + scrollX + r.width / 2, cy: r.top + scrollY + r.height / 2, w: r.width, h: r.height });
        return true;
      }
      lostSince ??= now;
      const scope = stateScope();
      if (!scope) { stop("버튼이 있던 영역이 사라져 중지했습니다. 새 화면에서 버튼을 다시 선택하세요.", true); return false; }
      let candidates = [...scope.querySelectorAll(INTERACTIVE)].filter(el => {
        if (el === target || el === host || host.contains(el) || !visible(el)) return false;
        const r = el.getBoundingClientRect();
        const wr = r.width / stateAnchor.w, hr = r.height / stateAnchor.h;
        if (r.width < 2 || r.height < 2 || wr < .6 || wr > 1.6 || hr < .6 || hr > 1.6) return false;
        const distance = Math.hypot(r.left + scrollX + r.width / 2 - stateAnchor.cx, r.top + scrollY + r.height / 2 - stateAnchor.cy);
        if (distance > Math.max(8, Math.min(stateAnchor.w, stateAnchor.h) * .5)) return false;
        const text = label(el);
        return !NOT_OPEN_TEXT.test(text) && !OTHER_ACTION_TEXT.test(text) &&
          ((stateAnchor.id && el.id === stateAnchor.id) || text === stateAnchor.text || BOOKING_ACTION_TEXT.test(text));
      });
      // button을 감싼 role=button 같은 중첩 래퍼를 중복 후보로 보지 않는다.
      candidates = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      if (candidates.length > 1) {
        stop("같은 자리에 버튼 후보가 여러 개여서 중지했습니다. 실제 예매 버튼을 다시 선택하세요.", true);
        return false;
      }
      if (candidates.length === 1) {
        target = candidates[0];
        lostSince = null;
        fp = makeFingerprint(target, now);
        stateAnchor = rememberStateSlot(target);
        ui.target.textContent = `선택: ${label(target) || target.tagName.toLowerCase()}`;
        return true;
      }
      if (now - lostSince > REPLACE_WAIT_MS) stop("같은 자리의 대체 예매 버튼을 찾지 못해 중지했습니다. 버튼을 다시 선택하세요.", true);
      else status("감시 중 · 같은 자리에 나타나는 새 예매 버튼을 기다립니다.");
      return false;
    }
    // 같은 태그 + 거의 같은 위치/크기 + (글자 or 클래스 유사) 일 때만 "같은 버튼"으로 인정. 후보가 둘 이상 동점이면 포기.
    function findReplacement(now) {
      if (now - lastSearch < 100) return null;
      lastSearch = now;
      if (fp.id) {
        const found = document.querySelectorAll(`#${CSS.escape(fp.id)}`);
        if (found.length === 1 && found[0].tagName === fp.tag) return found[0];
      }
      const unit = Math.max(fp.w, fp.h);
      let best = null, bestScore = 0, tie = false;
      for (const el of [...document.getElementsByTagName(fp.tag)].slice(0, 4000)) {
        if (el === host || host.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const wr = r.width / fp.w, hr = r.height / fp.h;
        if (wr < .6 || wr > 1.6 || hr < .6 || hr > 1.6) continue;
        const dist = Math.hypot(r.left + scrollX + r.width / 2 - fp.cx, r.top + scrollY + r.height / 2 - fp.cy);
        const pos = dist <= unit * .75 ? 2 : dist <= unit * 3 ? 1 : 0;
        if (pos === 0) continue;
        const sharedClass = fp.classes.some(c => el.classList.contains(c)) ? 1 : 0;
        const exact = pos === 2 && wr > .85 && wr < 1.18 && hr > .85 && hr < 1.18 ? 1 : 0;
        const score = pos + textScore(fp.text, label(el)) + sharedClass + exact;
        if (score < 3) continue;
        if (score > bestScore) { best = el; bestScore = score; tie = false; }
        else if (score === bestScore) tie = true;
      }
      return tie ? null : best;
    }
    function resolveTarget(now) {
      if (mode === "state") return stateAnchor ? resolveStateTarget(now) : false;
      if (target.isConnected) { lostSince = null; return true; }
      if (lostSince === null) lostSince = now;
      const next = findReplacement(now);
      if (next) { target = next; lostSince = null; fp = makeFingerprint(next, now); return true; }
      if (now - lostSince > REPLACE_WAIT_MS) stop("버튼이 페이지에서 사라져 중지했습니다. 버튼을 다시 선택하세요.", true);
      else status("버튼이 다시 그려지는 중 · 같은 자리에 나타나기를 기다립니다.");
      return false;
    }

    // ── 클릭 가능 여부 ────────────────────────────────────────────
    function enabled(el) {
      if (el.matches(":disabled")) return false;
      for (let p = el; p; p = p.parentElement) {
        if (p.hasAttribute("disabled") || p.hasAttribute("inert") || p.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
      }
      return getComputedStyle(el).pointerEvents !== "none";
    }
    // "ok" | "offscreen"(화면 밖: 가림 여부를 알 수 없으니 통과) | "blocked"
    function coverage(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return "blocked";
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return "offscreen";
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      host.style.setProperty("visibility", "hidden", "important");   // 우리 패널은 가림으로 취급하지 않는다
      try {
        for (const fraction of [.5, .25, .75]) {
          const hit = document.elementFromPoint(left + (right - left) * fraction, (top + bottom) / 2);
          if (hit && (hit === el || el.contains(hit))) return "ok";
        }
      } finally {
        host.style.setProperty("visibility", "visible", "important");
      }
      return "blocked";
    }
    // click() 만 보내면 pointerdown/mousedown 에 반응하는 사이트가 무시하므로 실제 클릭과 같은 순서로 보낸다.
    function dispatchClick(el) {
      const r = el.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", pointer));
      el.dispatchEvent(new MouseEvent("mouseup", base));
      el.click();
    }
    function fire(el, message) {
      // 클릭 핸들러가 DOM 을 바꿀 수 있으니 먼저 잠금 + 감시 해제
      fired = true;
      clearWatch();
      // UI를 펼치며 레이아웃을 바꾸기 전에 클릭부터 전송한다.
      let failed = false;
      try { dispatchClick(el); }
      catch { failed = true; }
      syncControls();
      status(failed ? "클릭 실행 중 오류가 발생해 중지했습니다. 예매 페이지를 확인하세요." : message);
      playSound(failed ? "stopped" : "fired");
    }

    // ── 감시 루프 ─────────────────────────────────────────────────
    // 예매 시간 직전(FAST_LEAD_MS)부터 지난 뒤(FAST_TAIL_MS)까지만 감시 주기를 짧게 바꾼다. 그 밖에는 평소 속도.
    // 색 전환·애니메이션은 화면 프레임이 갱신될 때만 값이 바뀐다. 프레임 사이에는 아무리 자주 확인해도 새 값을 볼 수 없고,
    // 일반 타이머는 프레임과 어긋나 평균 반 주기(약 8ms)를 더 기다린다. 그래서 확인을 프레임이 갱신되는 순간(그리기 직전)에 맞춘다.
    // 프레임이 멈춘 탭이거나 예매 시간 근처(고속 구간)에서는 기존 보조 타이머가 계속 확인한다.
    function pollTick() {
      if (!fastNow && !document.hidden && performance.now() - lastFrameAt < 50) return;
      throttledCheck();
    }
    function frameLoop() {
      frameId = 0;
      if (!watching || fired) return;
      frameId = requestAnimationFrame(frameLoop);
      const now = performance.now();
      lastFrameAt = now;
      if (!document.hidden && now - lastCheckAt >= FRAME_MIN_GAP_MS) check();
    }
    function applyPace() {
      if (!openAt) return;
      const fast = inFastWindow(openAt, Date.now());
      if (fast === fastNow) return;
      fastNow = fast;
      clearInterval(timer);
      timer = setInterval(pollTick, fast ? FAST_POLL_MS : POLL_INTERVAL_MS);
    }
    function paceNote() {
      if (!openAt) return "";
      const left = openAt - FAST_LEAD_MS - Date.now();
      return left > 0 ? ` · 고속 감시까지 ${fmtLeft(left)}` : fastNow ? " · 고속 감시 중" : "";
    }
    const checkGap = () => (fastNow ? FAST_CHECK_GAP_MS : MIN_CHECK_GAP_MS);
    function check() {
      if (!watching || fired) return;
      const now = performance.now();
      lastCheckAt = now;
      applyPace();
      if (!host.isConnected) { stop("페이지에서 감시 패널이 사라져 중지했습니다. 버튼을 다시 선택하세요.", true); return; }
      if (pageKey() !== runKey) {
        // 주소(경로)만 바뀐 것은 중단 사유가 아니다. SPA 는 화면 경로가 바뀌어도 같은 버튼이 그대로 남아 있을 수 있다.
        // 버튼이 아직 DOM 에 있으면 계속 감시하고(숨겨졌다면 아래에서 다시 보일 때까지 기다림),
        // 버튼이 사라졌다면 다른 화면의 비슷한 버튼을 잘못 클릭하지 않도록 바로 중지한다.
        if (target.isConnected) runKey = pageKey();
        else { stop("다른 화면으로 이동했고 버튼도 사라져 중지했습니다. 버튼을 다시 선택하세요.", true); return; }
      }
      if (now > deadline) { stop("1시간이 지나 감시를 종료했습니다. 필요하면 다시 시작하세요.", true); return; }
      if (!resolveTarget(now)) return;
      refreshFingerprint(target, now);
      if (!visible(target)) { status("감시 중 · 버튼이 다시 보이기를 기다립니다."); setLive(null); return; }

      if (mode === "state") {
        const active = enabled(target);
        setLive({ state: active ? "active" : "waiting", rgb: null, via: "state" });
        if (!active) { status(`감시 중 · 비활성 상태가 해제되기를 기다립니다${paceNote()}`); return; }
        if (OTHER_ACTION_TEXT.test(label(target))) { stop("예매 취소·내역 등 다른 기능의 버튼으로 바뀌어 클릭하지 않고 중지했습니다. 실제 예매 버튼을 다시 선택하세요.", true); return; }
        if (NOT_OPEN_TEXT.test(label(target))) { status("활성 상태지만 마감·종료·오픈 전 문구여서 기다립니다."); return; }
        if (coverage(target) === "blocked") { status("활성 상태 감지 · 가린 창을 닫으면 다시 확인합니다."); return; }
        fire(target, "DOM 활성 상태를 확인해 1회 클릭하고 멈췄습니다. 예매 페이지에서 실제 진행 결과를 확인하세요.");
        return;
      }

      let color;
      if (mode === "timer") {
        const text = label(target);
        setLive(`현재 감지: 카운트다운 감시 · "${text}"`);
        if (!text || isTimerText(text)) { status(`감시 중 · 카운트다운이 끝나기를 기다립니다${paceNote()}`); return; }
        if (NOT_OPEN_TEXT.test(text)) { status(`감시 중 · ‘${text.length > 16 ? text.slice(0, 16) + "…" : text}’ 상태라 클릭하지 않고 기다립니다${paceNote()}`); return; }
        color = { state: "active", rgb: null };      // 숫자가 사라지고 ‘닫힘’ 글자도 아니다 = 열렸다
      } else {
        color = currentColor(now);
        setLive(color);
        if (color.state === "unsupported") {
          if (color.hiddenTab) { unreadableSince = null; status("감시 중 · 이 탭이 가려져 있습니다. 앞으로 가져오세요."); return; }
          unreadableSince ??= now;
          if (now - unreadableSince > UNREADABLE_LIMIT_MS) stop(`버튼 색을 읽을 수 없어 중지했습니다 (${color.reason})`, true);
          else status(color.pending ? "감시 중 · 화면 색을 읽는 중입니다." : `감시 중 · 색을 읽지 못하고 있습니다 (${color.reason})`);
          return;
        }
      }
      unreadableSince = null;
      if (mode === "color" && !activationChanged(color)) { status(`감시 중 · 대기색에서 바뀌기를 기다립니다${color.via === "pixel" ? " (화면 캡처)" : ""}${paceNote()}`); return; }
      if (!enabled(target)) { status("색상 변화 감지 · 활성화되기를 기다립니다."); return; }

      if (coverage(target) === "blocked") {
        status("색상 변화 감지 · 가린 창을 닫으면 다시 확인합니다.");
        return;
      }
      fire(target, "클릭을 1회 실행하고 멈췄습니다. 예매 페이지에서 실제 진행 결과를 확인하세요.");
    }
    // 대상 버튼 변경과 새 캡처 결과는 즉시 확인하고, 그 밖의 반복 알림만 간격을 둔다.
    function immediateCheck() {
      if (!watching || fired) return;
      clearTimeout(scheduled); scheduled = 0;
      check();
    }
    function scheduleCheck() {
      if (!watching || scheduled) return;
      const wait = Math.max(0, checkGap() - (performance.now() - lastCheckAt));
      scheduled = setTimeout(() => { scheduled = 0; check(); }, wait);
    }
    function throttledCheck() {
      if (performance.now() - lastCheckAt >= checkGap()) check(); else scheduleCheck();
    }
    async function start() {
      prepareAudio();   // ‘감시 시작’ 클릭(사용자 동작) 안에서 만들어 둬야 나중에 소리가 난다
      if (watching || selecting || starting || !target) return;
      if (!target.isConnected) { status("선택한 버튼이 페이지에서 사라졌습니다. 버튼을 다시 선택하세요."); return; }
      if (document.hidden || !visible(target)) { status("선택한 버튼을 이 탭에 보이게 한 뒤 다시 시작하세요."); return; }
      const schedule = parseOpenAt(ui.openAt.value);
      if (schedule.error) { status(schedule.error); return; }
      if (schedule.at) {
        const gap = schedule.at - Date.now();
        if (gap < -FAST_TAIL_MS) { status("입력한 예매 시간이 이미 지났습니다. 시간을 고치거나 비워 두고 시작하세요."); return; }
        if (gap > WATCH_LIMIT_MS - FAST_TAIL_MS) { status("예매 시간까지 59분 넘게 남았습니다. 감시는 최대 1시간이라 그 전에 끝납니다. 예매 시간에 가까워졌을 때 시작하세요."); return; }
      }
      const el = target;
      const ticket = ++operation;
      starting = true;
      syncControls();
      const wantsState = ui.trigger.value === "state";
      status(wantsState ? "버튼의 비활성 상태를 확인하는 중입니다…" : "버튼 색을 확인하는 중입니다…");
      let color;
      // DOM 모드의 기준 확인과 Observer 설치 사이에는 await로 제어를 넘기지 않는다.
      try { color = wantsState ? { state: enabled(el) ? "active" : "waiting", rgb: null, via: "state" } : await readNow(el); }
      catch (error) { color = { state: "unsupported", rgb: null, reason: `오류: ${error?.message ?? error}` }; }
      finally { starting = false; syncControls(); }
      setLive(color);
      if (ticket !== operation || watching || selecting || el !== target) return;
      if (!el.isConnected || document.hidden || !visible(el)) { status("선택한 버튼이 화면에서 보이지 않습니다. 버튼을 보이게 한 뒤 다시 시작하세요."); return; }
      let nextMode = wantsState ? "state" : "color";
      if (wantsState && color.state === "active") {
        status("이 버튼은 이미 활성 상태라 DOM 감시를 시작하지 않았습니다. 비활성 버튼을 선택하거나 ‘색상 변화’ 모드를 사용하세요.");
        return;
      }
      if (color.state === "unsupported") {
        if (!isTimerText(label(el))) { status(`버튼 색을 읽을 수 없습니다 (${color.reason}) 색이 칠해진 영역을 다시 선택하거나, 버튼이 화면 안에 보이는지 확인하세요.`); return; }
        nextMode = "timer";
      }
      mode = nextMode;
      baseline = nextMode === "color" ? { rgb: [...color.rgb], ownRGB: color.ownRGB ? [...color.ownRGB] : null } : null;
      stateAnchor = nextMode === "state" ? rememberStateSlot(el) : null;
      openAt = schedule.at;
      pixelEvery = ui.cadence.checked ? PIXEL_PERIODIC_MS : PIXEL_EVENT_FIRST_MS;
      fastNow = false;
      burstUntil = 0;
      fired = false;
      watching = true;
      lostSince = unreadableSince = null;
      runKey = pageKey();
      deadline = performance.now() + WATCH_LIMIT_MS;
      // 대상 버튼과 조상의 상태 변화는 즉시 확인한다. CSS 애니메이션은 보조 타이머가 확인한다.
      // 이미지 교체(src 등)는 버튼 근처일 때만 신호로 본다(페이지의 다른 이미지가 바뀌는 건 무시).
      const IMAGE_ATTRS = new Set(["src", "srcset", "href", "xlink:href", "fill", "stroke"]);
      observer = new MutationObserver(records => {
        let relevant = false, near = false;
        for (const record of records) {
          if (record.target === host) continue;
          const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const scope = mode === "state" ? stateScope() : null;
          const stateNear = scope && node && (node === scope || scope.contains(node) || node.contains(scope));
          const isNear = nearTarget(record.target) || !!node?.contains(target) || !!stateNear;
          if (record.type === "attributes" && IMAGE_ATTRS.has(record.attributeName) && !isNear) continue;
          relevant = true;
          if (isNear) { near = true; break; }
        }
        if (!relevant) return;
        if (near) {
          domBlockedUntil = 0;
          kickPixel(performance.now());
          immediateCheck();
        // 버튼과 무관한 곳(실시간 시계·배너 등)이 계속 바뀌는 페이지에서 확인이 잦아져 레이아웃 계산이 늘어나는 것을 막는다.
        // 앞에 보이는 탭은 프레임 루프가 매 프레임 확인하므로 건너뛰고, 가려진 탭·고속 감시 구간에서만 따로 확인한다.
        } else if (document.hidden || fastNow) throttledCheck();
      });
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
        attributeFilter: ["class", "style", "disabled", "aria-disabled", "hidden", "inert", "data-state", "data-status", "data-disabled", ...IMAGE_ATTRS],
      });
      for (const type of VISUAL_EVENTS) document.addEventListener(type, onVisualEvent, true);
      timer = setInterval(pollTick, POLL_INTERVAL_MS);
      lastFrameAt = 0;
      frameId = requestAnimationFrame(frameLoop);
      syncControls();
      avoidTarget();
      status(mode === "state" ? `감시 중 · 비활성이 해제되면 색상 대기 없이 1회 클릭합니다${paceNote()}`
        : mode === "timer" ? `감시 중 · 카운트다운이 끝나면 클릭합니다${paceNote()}` : `감시 중 · 색이 바뀌면 1회 클릭합니다${paceNote()}`);
      check();
    }

    // ── 이벤트 연결 ───────────────────────────────────────────────
    ui.select.addEventListener("click", () => {
      selecting = true;
      ui.picker.hidden = false;
      status("대기 중인 예매 버튼 가운데를 클릭해 지정하세요. 선택 클릭은 예매 버튼으로 전달되지 않습니다. Esc로 취소");
      syncControls();
    });
    ui.trigger.addEventListener("change", async () => {
      const ticket = ++operation;
      pixel = null; lastRGB = null; baseline = null;
      ui.sub.textContent = ui.trigger.value === "state"
        ? "비활성 → 활성 상태 · 색상 변화 대기 없이 1회 클릭"
        : "대기색 → 활성 색상 · 색상이 충분히 바뀌면 1회 클릭";
      syncControls();
      const el = target;
      if (!el || watching || starting) { setLive(null); return; }
      starting = true; syncControls();
      let color;
      try { color = await readNow(el); }
      catch (error) { color = { state: "unsupported", rgb: null, reason: String(error?.message ?? error) }; }
      finally { starting = false; syncControls(); }
      if (ticket !== operation || el !== target) return;
      setLive(color);
      status(ui.trigger.value === "state"
        ? (color.state === "active" ? "현재 버튼은 이미 활성입니다. 비활성 버튼을 선택하거나 ‘색상 변화’를 사용하세요." : "DOM 상태 모드입니다. ‘감시 시작’ 후 비활성 해제 시 1회 클릭합니다.")
        : "색상 변화 모드입니다. 대기 상태에서 ‘감시 시작’을 누르면 현재 색을 기준으로 기억합니다.");
    });
    ui.picker.addEventListener("pointerdown", event => { event.preventDefault(); event.stopPropagation(); });
    ui.picker.addEventListener("pointerup", event => { event.preventDefault(); event.stopPropagation(); });
    ui.picker.addEventListener("click", pick);
    ui.picker.addEventListener("pointermove", event => {
      if (moveQueued) return;
      moveQueued = true;
      const { clientX: x, clientY: y } = event;
      requestAnimationFrame(() => { moveQueued = false; if (selecting) outline(findAt(x, y)); });
    });
    ui.soundTest.addEventListener("click", () => {
      prepareAudio();
      playSound("fired", true);
      setTimeout(() => playSound("stopped", true), 700);
    });
    ui.sound.addEventListener("change", () => { if (ui.sound.checked) { prepareAudio(); playSound("fired", true); } });
    ui.start.addEventListener("click", start);
    ui.frames.addEventListener("click", () => {
      bridge.opened = 0;
      bridge.relay("show-panel");
      status("프레임 안에 패널을 여는 중입니다…");
      setTimeout(() => {
        if (watching || selecting || starting) return;
        status(bridge.opened
          ? `프레임 ${bridge.opened}개에 패널을 열었습니다. 버튼이 들어 있는 프레임의 패널에서 ‘버튼 선택’을 누르세요.`
          : "열 수 있는 프레임이 없습니다. 버튼이 프레임 안에 있다면 확장프로그램 아이콘을 눌러 ‘프레임 접근 허용’을 한 뒤 다시 시도하세요. (너무 작은 프레임에는 열지 않습니다)");
      }, 900);
    });
    ui.force.addEventListener("change", async () => {
      forcePixel = ui.force.checked;
      pixel = null;
      const el = target;
      if (!el || watching || starting) return;
      starting = true;
      syncControls();
      status("버튼 색을 다시 확인하는 중입니다…");
      let color;
      try { color = await readNow(el); }
      catch (error) { color = { state: "unsupported", rgb: null, reason: `오류: ${error?.message ?? error}` }; }
      finally { starting = false; syncControls(); }
      setLive(color);
      status(color.state === "unsupported" ? `이 버튼의 색을 읽을 수 없습니다 (${color.reason})` : "다시 확인했습니다. 버튼이 대기 상태일 때 ‘감시 시작’을 누르면 현재 색을 대기 기준으로 기억합니다.");
    });
    for (const type of ["keydown", "keyup", "keypress"]) ui.openAt.addEventListener(type, event => event.stopPropagation());
    ui.stop.addEventListener("click", () => stop());
    ui.move.addEventListener("click", () => ui.panel.classList.toggle("left"));
    ui.close.addEventListener("click", () => { stop(); host.style.setProperty("display", "none", "important"); });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && (watching || selecting || starting)) stop("Esc로 중지했습니다.");
    }, true);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && selecting) stop("다른 탭으로 이동해 버튼 선택을 취소했습니다.");   // 감시 중에는 계속 유지
    });
    window.addEventListener("pagehide", () => stop("페이지를 벗어나 감시를 종료했습니다."));
    window.addEventListener("popstate", () => { if (watching) throttledCheck(); });
    if (!bridge.isTop) {   // 프레임 안의 패널: 최상위 패널과 겹치지 않게 왼쪽에, 어느 프레임인지 표시
      ui.panel.classList.add("left");
      ui.title.textContent = "예매 버튼 한 번 클릭 · 프레임";
      ui.sub.textContent = `${location.hostname || "프레임"} · DOM 비활성→활성 · 1회 클릭`;
    }
    syncControls();
    return { show() { host.style.removeProperty("display"); if (!host.isConnected) document.documentElement.append(host); } };
  }

  if (isTop) ensurePanel();
  globalThis[KEY] = { show() { if (isTop) ensurePanel().show(); else api?.show(); } };
})();
