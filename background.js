importScripts(
  "source-parse.js",
  "source-cache.js",
  "api-mapping.js",
  "api-returns.js",
  "api-reader.js"
);

const JOB_STORAGE_LIST_CAP = 400;
const RESULTS_CACHE_MAX_ENTRIES = 25000;
const PERSIST_THROTTLE_MS = 2000;
const PERSIST_EVERY_ITEMS = 25;
const KEEP_ALIVE_ALARM = "goodsAuditKeepAlive";
const KEEP_ALIVE_PERIOD_MIN = 0.5;
const OFFSCREEN_URL = "offscreen.html";
let offscreenCreating = null;
const PAGE_LOAD_TIMEOUT_MS = 90000;
const MARKER_WAIT_MS = 16000;
const processedWriteBuffer = new Set();
let processedFlushTimer = null;
let reconcileInFlight = null;
const resumeLocks = { file: null, text: null };
const lastAutoResumeAt = { file: 0, text: 0 };
const persistQueues = {
  file: { pending: null, timer: null, itemCounter: 0, lastAt: 0 },
  text: { pending: null, timer: null, itemCounter: 0, lastAt: 0 },
};
const jobClearedModes = { file: false, text: false };
const BASE = "https://returns.o3t.ru/items/article/";
const JOB_KEY_FILE = "returnsExcelJobFileV1";
const JOB_KEY_TEXT = "returnsExcelJobTextV1";
const PROCESSED_KEY = "processedArticleIds";
const RESULTS_CACHE_KEY = "processedResultsCacheV1";
const POPUP_PREFS_KEY = "returnsPopupPrefsV1";

const runStates = {
  file: {
    workerWindowId: null,
    abortRequested: false,
    pauseRequested: false,
    activeRunConfig: null,
    running: false,
    liveJob: null,
    boostTimerId: null,
    lastHeartbeatAt: 0,
    closingWindowIds: new Set(),
  },
  text: {
    workerWindowId: null,
    abortRequested: false,
    pauseRequested: false,
    activeRunConfig: null,
    running: false,
    liveJob: null,
    boostTimerId: null,
    lastHeartbeatAt: 0,
    closingWindowIds: new Set(),
  },
};

// --- Авто-скорость -----------------------------------------------------------
// Потоки подбираются под железо (ядра/память), а паузы и время ожидания
// страницы адаптируются на лету по фактическому поведению сайта: успехи
// ускоряют обработку, медленные страницы и ошибки — притормаживают (AIMD).
const SPEED_MIN_SETTLE_MS = 150;
const SPEED_MAX_SETTLE_MS = 4500;
const SPEED_START_SETTLE_MS = 450;
const SPEED_MIN_DELAY_MS = 0;
const SPEED_MAX_DELAY_MS = 2200;
const SPEED_START_DELAY_MS = 150;
const SPEED_MAX_THREADS = 8;

function computeAutoThreads(itemCount) {
  const cores = Math.max(2, Math.floor(Number(navigator.hardwareConcurrency) || 4));
  const memGb = Number(navigator.deviceMemory) || 4;
  let threads = Math.round(cores * 0.75);
  if (memGb <= 2) threads = Math.min(threads, 2);
  else if (memGb <= 4) threads = Math.min(threads, 4);
  else if (memGb <= 8) threads = Math.min(threads, 6);
  else threads = Math.min(threads, SPEED_MAX_THREADS);
  threads = Math.max(2, Math.min(SPEED_MAX_THREADS, threads));
  const count = Math.floor(Number(itemCount) || 0);
  if (count > 0) threads = Math.min(threads, count);
  return Math.max(1, threads);
}

const MANUAL_THREADS_HARD_CAP = 25;

function parseManualThreads(value) {
  const n = Math.floor(Number(value) || 0);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(MANUAL_THREADS_HARD_CAP, n);
}

function createSpeedController(maxThreads, opts = {}) {
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // fixedThreads: пользователь выбрал число потоков вручную — контроллер
  // адаптирует только паузы, а число потоков не трогает.
  const fixedThreads = opts.fixedThreads === true;
  const st = {
    maxThreads: Math.max(1, Math.floor(Number(maxThreads) || 1)),
    threadLimit: Math.max(1, Math.floor(Number(maxThreads) || 1)),
    settleMs: SPEED_START_SETTLE_MS,
    delayMs: SPEED_START_DELAY_MS,
    okStreak: 0,
    slowStreak: 0,
    failStreak: 0,
    emaItemMs: 0,
    itemsDone: 0,
  };
  return {
    getSettleMs: () => Math.round(st.settleMs),
    getDelayMs: () => Math.round(st.delayMs),
    getThreadLimit: () => st.threadLimit,
    reportItem({ ok, slow = false, hardFail = false, durationMs = 0 }) {
      st.itemsDone += 1;
      const dur = Number(durationMs) || 0;
      if (dur > 0) {
        st.emaItemMs = st.emaItemMs > 0 ? st.emaItemMs * 0.8 + dur * 0.2 : dur;
      }
      if (ok && !slow) {
        st.okStreak += 1;
        st.slowStreak = 0;
        st.failStreak = 0;
        st.settleMs = clampNum(st.settleMs * 0.93 - 8, SPEED_MIN_SETTLE_MS, SPEED_MAX_SETTLE_MS);
        st.delayMs = clampNum(st.delayMs - 35, SPEED_MIN_DELAY_MS, SPEED_MAX_DELAY_MS);
        if (!fixedThreads && st.okStreak >= 10 && st.threadLimit < st.maxThreads) {
          st.threadLimit += 1;
          st.okStreak = 0;
        }
      } else if (ok && slow) {
        st.okStreak = 0;
        st.failStreak = 0;
        st.slowStreak += 1;
        st.settleMs = clampNum(st.settleMs * 1.2 + 120, SPEED_MIN_SETTLE_MS, SPEED_MAX_SETTLE_MS);
        st.delayMs = clampNum(st.delayMs + 60, SPEED_MIN_DELAY_MS, SPEED_MAX_DELAY_MS);
        if (!fixedThreads && st.slowStreak >= 6 && st.threadLimit > 2) {
          st.threadLimit -= 1;
          st.slowStreak = 0;
        }
      } else {
        st.okStreak = 0;
        st.slowStreak = 0;
        st.failStreak += 1;
        st.settleMs = clampNum(st.settleMs * 1.45 + 200, SPEED_MIN_SETTLE_MS, SPEED_MAX_SETTLE_MS);
        st.delayMs = clampNum(st.delayMs + 150, SPEED_MIN_DELAY_MS, SPEED_MAX_DELAY_MS);
        if (!fixedThreads && (hardFail || st.failStreak >= 2) && st.threadLimit > 1) {
          st.threadLimit -= 1;
          st.failStreak = 0;
        }
      }
    },
    snapshot() {
      return {
        auto: true,
        threads: st.threadLimit,
        maxThreads: st.maxThreads,
        settleMs: Math.round(st.settleMs),
        delayMs: Math.round(st.delayMs),
        avgItemMs: Math.round(st.emaItemMs),
      };
    },
  };
}

function normalizeSourceMode(mode) {
  return mode === "text" ? "text" : "file";
}

function getJobKeyByMode(mode) {
  return normalizeSourceMode(mode) === "text" ? JOB_KEY_TEXT : JOB_KEY_FILE;
}

function getRunState(mode) {
  return runStates[normalizeSourceMode(mode)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(timeoutMessage)), Math.max(1000, Number(timeoutMs) || 1000));
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(t);
    });
  });
}

function getWindow(windowId) {
  return new Promise((resolve, reject) => {
    chrome.windows.get(windowId, {}, (w) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(w);
    });
  });
}

function updateTab(tabId, updateProps) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProps, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function updateWindow(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (w) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(w);
    });
  });
}

function stopWorkerBoost(mode = "file") {
  const state = getRunState(mode);
  if (state.boostTimerId != null) {
    clearInterval(state.boostTimerId);
    state.boostTimerId = null;
  }
}

function touchWorkerHeartbeat(mode = "file") {
  const state = getRunState(mode);
  state.lastHeartbeatAt = Date.now();
}

async function hasOffscreenKeepAlive() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      return contexts.length > 0;
    }
    if (chrome.offscreen?.hasDocument) {
      return await chrome.offscreen.hasDocument();
    }
  } catch {
  }
  return false;
}

async function ensureOffscreenKeepAlive() {
  if (!chrome.offscreen?.createDocument) return;
  try {
    if (await hasOffscreenKeepAlive()) return;
    if (offscreenCreating) {
      await offscreenCreating;
      return;
    }
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Keep batch processing running while the popup is closed",
    });
    await offscreenCreating;
  } catch {
  } finally {
    offscreenCreating = null;
  }
}

async function closeOffscreenKeepAlive() {
  if (!chrome.offscreen?.closeDocument) return;
  try {
    if (await hasOffscreenKeepAlive()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
  }
}

async function anyJobNeedsBackgroundKeepAlive() {
  const anyLive = ["file", "text"].some((mode) => {
    const state = getRunState(mode);
    return state.running || state.liveJob?.phase === "running" || state.liveJob?.phase === "paused";
  });
  if (anyLive) return true;
  try {
    const jobs = await chrome.storage.local.get([JOB_KEY_FILE, JOB_KEY_TEXT]);
    for (const key of [JOB_KEY_FILE, JOB_KEY_TEXT]) {
      const phase = jobs[key]?.phase;
      if (phase === "running" || phase === "paused") return true;
    }
  } catch {
  }
  return false;
}

async function ensureKeepAliveAlarm() {
  try {
    const existing = await chrome.alarms.get(KEEP_ALIVE_ALARM);
    if (!existing) {
      await chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: KEEP_ALIVE_PERIOD_MIN });
    }
  } catch {
  }
  
  await ensureOffscreenKeepAlive();
}

async function clearKeepAliveAlarmIfIdle() {
  if (await anyJobNeedsBackgroundKeepAlive()) {
    await ensureOffscreenKeepAlive();
    return;
  }
  try {
    await chrome.alarms.clear(KEEP_ALIVE_ALARM);
  } catch {
  }
  await closeOffscreenKeepAlive();
}

async function persistWorkerWindowMeta(mode, windowId, tabIds = null) {
  const jobKey = getJobKeyByMode(mode);
  try {
    const obj = await chrome.storage.local.get(jobKey);
    const job = obj[jobKey];
    if (!job || (job.phase !== "running" && job.phase !== "paused")) return;
    job.workerWindowId = windowId == null ? null : Number(windowId);
    if (Array.isArray(tabIds)) {
      job.workerTabIds = tabIds.filter((id) => id != null);
    }
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ [jobKey]: job });
  } catch {
  }
}

async function clearPersistedWorkerWindowMeta(mode) {
  const jobKey = getJobKeyByMode(mode);
  try {
    const obj = await chrome.storage.local.get(jobKey);
    const job = obj[jobKey];
    if (!job) return;
    if (job.workerWindowId == null && !Array.isArray(job.workerTabIds)) return;
    delete job.workerWindowId;
    delete job.workerTabIds;
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ [jobKey]: job });
  } catch {
  }
}

async function isChromeWindowAlive(windowId) {
  if (windowId == null) return false;
  return await new Promise((resolve) => {
    chrome.windows.get(windowId, {}, (_w) => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function safeRemoveWindow(windowId) {
  if (windowId == null) return;
  await new Promise((resolve) => {
    chrome.windows.remove(windowId, () => resolve());
  });
}

async function hydrateWorkerWindowId(mode = "file") {
  const state = getRunState(mode);
  if (state.workerWindowId != null && (await isChromeWindowAlive(state.workerWindowId))) {
    return state.workerWindowId;
  }
  const jobKey = getJobKeyByMode(mode);
  const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
  const storedWid = job?.workerWindowId;
  if (storedWid != null && (await isChromeWindowAlive(storedWid))) {
    state.workerWindowId = Number(storedWid);
    return state.workerWindowId;
  }
  if (state.workerWindowId != null) state.workerWindowId = null;
  return null;
}

async function forceTabPerformanceMode(tabId) {
  await updateTab(tabId, { autoDiscardable: false });
}

async function forceWindowPerformanceMode(windowId, focusWindow = false) {
  if (!focusWindow) return;
  const win = await getWindow(windowId);
  const winState = String(win?.state || "");
  const patch = { focused: true, drawAttention: true };
  if (winState === "minimized") patch.state = "normal";
  await updateWindow(windowId, patch);
  await updateWindow(windowId, { focused: true }).catch(() => {});
}

async function bringWorkerTabToFront(windowId, tabId) {
  if (windowId != null) {
    await forceWindowPerformanceMode(windowId, true).catch(() => {});
  }
  if (tabId != null) {
    await updateTab(tabId, { active: true }).catch(() => {});
  }
}

const WORKER_BOOST_INTERVAL_MS = 450;

async function ensureTabNotDiscarded(tabId) {
  let tab;
  try {
    tab = await getTab(tabId);
  } catch {
    return;
  }
  await forceTabPerformanceMode(tabId).catch(() => {});
  if (tab?.discarded) {
    await new Promise((resolve) => {
      chrome.tabs.reload(tabId, {}, () => resolve());
    });
  }
}

function startWorkerBoost(mode, windowId, tabIds, bringToFront = false) {
  stopWorkerBoost(mode);
  if (windowId == null || !Array.isArray(tabIds) || tabIds.length === 0) return;
  const state = getRunState(mode);
  let activeIdx = 0;
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) return;
    if (state.workerWindowId !== windowId) return;
    if (state.pauseRequested || state.abortRequested) return;
    tickInFlight = true;
    try {
      touchWorkerHeartbeat(mode);
      const tabId = tabIds[activeIdx % tabIds.length];
      activeIdx += 1;
      if (bringToFront) {
        await bringWorkerTabToFront(windowId, tabId);
      }
      if (tabId != null) await ensureTabNotDiscarded(tabId).catch(() => {});
    } finally {
      tickInFlight = false;
    }
  };

  void tick();

  state.boostTimerId = setInterval(() => {
    void tick();
  }, WORKER_BOOST_INTERVAL_MS);
}

async function closeWorkerResources(mode = "file") {
  const state = getRunState(mode);
  stopWorkerBoost(mode);
  const memoryWid = state.workerWindowId;
  state.workerWindowId = null;

  const jobKey = getJobKeyByMode(mode);
  let storedWid = null;
  try {
    const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
    storedWid = job?.workerWindowId ?? null;
  } catch {
    storedWid = null;
  }

  const toClose = new Set();
  if (memoryWid != null) toClose.add(Number(memoryWid));
  if (storedWid != null) toClose.add(Number(storedWid));
  for (const wid of toClose) {
    state.closingWindowIds.add(wid);
  }
  try {
    for (const wid of toClose) {
      await safeRemoveWindow(wid);
    }
    await clearPersistedWorkerWindowMeta(mode);
  } finally {
    for (const wid of toClose) {
      state.closingWindowIds.delete(wid);
    }
  }
}

function execScriptFiles(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files }, (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(r);
    });
  });
}

function execScriptFunc(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, func, args }, (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(r);
    });
  });
}

async function waitForDataMarkers(
  tabId,
  timeoutMs = MARKER_WAIT_MS,
  isAbortRequested = () => false,
  isPauseRequested = () => false
) {
  
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    while (isPauseRequested() && !isAbortRequested()) {
      await sleep(120);
    }
    if (isAbortRequested()) {
      throw new Error("Остановлено");
    }
    const results = await execScriptFunc(tabId, () => {
      const text = (document.body?.innerText || "").replace(/\u00a0/g, " ");
      if (text.includes("Неподдерживаемый тип")) return true;
      const hasClassic =
        text.includes("Упаковка отправления") &&
        text.includes("Номенклатура") &&
        text.includes("Отправление");
      const hasInstancePage =
        text.includes("Экземпляр") &&
        text.includes("Основная информация") &&
        text.includes("Отправления");
      const hasTransitBox =
        text.includes("Номер транзитной коробки") ||
        (text.includes("Транзитная коробка") &&
          (text.includes("Коробка с возвратами") || text.includes("FBO")));
      const hasC2C =
        (/\bC2C\b/i.test(text) || /с2с/i.test(text)) &&
        (text.includes("Номенклатура") ||
          text.includes("Основная информация") ||
          text.includes("Схема доставки"));
      return hasClassic || hasTransitBox || hasInstancePage || hasC2C;
    });
    if (Boolean(results?.[0]?.result)) return true;
    // Первую секунду опрашиваем часто. По замерам данные появляются раньше,
    // чем через 250 мс, и на грубом шаге мы теряли этот интервал целиком на
    // каждом чтении: медиана ожидания маркеров была ровно 255 мс, то есть
    // один впустую проспанный шаг. Дальше шаг растёт — страницу, которая всё
    // равно не готова, долбить незачем.
    const waited = Date.now() - startedAt;
    await sleep(waited < 1000 ? 45 : waited < 4000 ? 150 : 400);
  }
  return false;
}

async function waitUntilArticlePage(
  tabId,
  articleId,
  timeoutMs = PAGE_LOAD_TIMEOUT_MS,
  isAbortRequested = () => false,
  isPauseRequested = () => false
) {
  const id = String(articleId || "");
  const needleExact = `/article/${id}`;
  const needleEncoded = `/article/${encodeURIComponent(id)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    while (isPauseRequested() && !isAbortRequested()) {
      await sleep(140);
    }
    if (isAbortRequested()) {
      throw new Error("Остановлено");
    }
    let tab;
    try {
      tab = await getTab(tabId);
    } catch {
      throw new Error("Рабочая вкладка закрыта");
    }
    if (tab.discarded) {
      await new Promise((resolve, reject) => {
        chrome.tabs.reload(tabId, {}, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
      await sleep(300);
      continue;
    }
    const url = String(tab.url || "");
    if (tab.status === "complete" && url.includes("/items/article/")) {
      
      if (
        url.includes(needleExact) ||
        url.includes(needleEncoded) ||
        (id && decodeURIComponent(url).includes(id))
      ) {
        return tab;
      }
      
      if (Date.now() > deadline - timeoutMs + 5000) return tab;
    }
    await sleep(200);
  }
  throw new Error("Таймаут: страница не загрузилась (войдите на returns.o3t.ru)");
}

// --- API-чтение: браузерные примитивы для api-reader.js ---------------------
// Потолок запросов в секунду на весь прогон. Объекту нужно 3-4 запроса
// (тип, карточка, состав, иногда перевозка), так что это и есть реальный
// предел скорости: 40 rps ≈ 11 объектов в секунду.
const API_READ_DEFAULT_RPS = 40;
const ARTICLE_ORIGIN = "https://returns.o3t.ru";

async function getApiReadPrefs() {
  try {
    const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
    const enabled = prefs?.apiReadEnabled !== false; // по умолчанию включено
    const parsedRps = Number(prefs?.apiReadRps);
    const rps = Number.isFinite(parsedRps) && parsedRps > 0 ? parsedRps : API_READ_DEFAULT_RPS;
    return { enabled, rps };
  } catch {
    return { enabled: true, rps: API_READ_DEFAULT_RPS };
  }
}

async function captureAndClearOnTab(tabId) {
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: () => {
            try {
              const buf = window.__gaCapturedRequests;
              if (!Array.isArray(buf)) return [];
              const copy = buf.slice();
              buf.length = 0;
              return copy;
            } catch (e) {
              return [];
            }
          },
        },
        (r) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(r);
        }
      );
    });
    const list = res?.[0]?.result;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function replayApiOnTab(tabId, req, headers) {
  const res = await new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        args: [req, headers || {}],
        func: (request, extraHeaders) => {
          const base = Object.assign(
            { "content-type": "application/json", accept: "application/json" },
            extraHeaders || {}
          );
          const init = {
            method: request.method || "GET",
            credentials: "include",
            headers: base,
          };
          if (request.body != null && init.method !== "GET" && init.method !== "HEAD") {
            init.body = request.body;
          }
          return fetch(request.url, init)
            .then((r) =>
              r
                .text()
                .then((t) => {
                  let data = null;
                  try {
                    data = t ? JSON.parse(t) : null;
                  } catch (e) {}
                  return { status: r.status, body: data };
                })
                .catch(() => ({ status: r.status, body: null }))
            )
            .catch((e) => ({ status: 0, body: null, error: String(e) }));
        },
      },
      (r) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(r);
      }
    );
  });
  return res?.[0]?.result || { status: 0, body: null };
}

async function isTabOnArticleOrigin(tabId) {
  try {
    const tab = await getTab(tabId);
    return String(tab?.url || "").startsWith(ARTICLE_ORIGIN);
  } catch {
    return false;
  }
}

async function scrapeArticleOnTab(
  tabId,
  articleId,
  settleMs,
  opsWarehouses,
  fallbackShipment = "",
  isAbortRequested = () => false,
  isPauseRequested = () => false,
  perf = null
) {
  const url = `${BASE}${encodeURIComponent(articleId)}`;
  const opsArg = Array.isArray(opsWarehouses) ? opsWarehouses : [];
  const resolveSettleMs = () =>
    Math.max(0, Number(typeof settleMs === "function" ? settleMs() : settleMs) || 0);

  async function waitIfPaused() {
    while (isPauseRequested() && !isAbortRequested()) {
      await sleep(140);
    }
    if (isAbortRequested()) {
      throw new Error("Остановлено");
    }
  }

  function hasPrice(s) {
    return s?.price != null && s?.price !== "" && Number.isFinite(Number(s.price));
  }

  function snapshotScore(s) {
    if (!s || typeof s !== "object" || s.__error) return 0;
    let n = 0;
    const scrapedId = String(s.articleId || "").trim();
    if (/^\d{10,35}$/.test(scrapedId)) n += 5;
    else if (scrapedId.length >= 8) n += 1;
    if (String(s.shipment || "").trim().length >= 3) n += 1;
    if (String(s.nomenclature || "").trim().length >= 2) n += 1;
    if (hasPrice(s)) n += 1;
    if (String(s.operationalWarehouse || "").trim().length >= 2) n += 1;
    if (String(s.deliveryScheme || "").trim().length >= 1) n += 1;
    if (String(s.formationWarehouse || "").trim().length >= 2) n += 1;
    if (String(s.owner || "").trim().length >= 2) n += 1;
    if (String(s.status || "").trim().length >= 2) n += 1;
    if (String(s.statusLozon || "").trim().length >= 2) n += 1;
    if (String(s.statusAlps || "").trim().length >= 2) n += 1;
    return n;
  }

  
  
  function snapshotHasAnyData(s) {
    return (
      snapshotScore(s) > 0 ||
      Boolean(s?.isTransitBox) ||
      Boolean(s?.isC2C) ||
      Boolean(s?.unsupportedTransitBox)
    );
  }

  
  
  function snapshotLooksFull(s) {
    if (!s || typeof s !== "object" || s.__error) return false;
    if (s.unsupportedTransitBox) return true;
    const isTransit = Boolean(s.isTransitBox);
    const isC2C = Boolean(s.isC2C);
    const isSpecial = isTransit || isC2C;
    const hasLozonId = /^\d{10,35}$/.test(String(s.articleId || "").trim());
    return (
      hasLozonId &&
      String(s.shipment || "").trim().length >= 3 &&
      (isSpecial || String(s.nomenclature || "").trim().length >= 2) &&
      (isSpecial || hasPrice(s))
    );
  }

  async function readSnapshotAfterInject() {
    let best = null;
    let bestScore = 0;
    const maxReads = 10;
    for (let attempt = 0; attempt < maxReads; attempt++) {
      await waitIfPaused();
      if (isAbortRequested()) {
        throw new Error("Остановлено");
      }
      if (perf) perf.attempts = Math.max(Number(perf.attempts) || 0, attempt + 1);
      if (attempt > 0) {
        await sleep(Math.min(900, 350 + Math.round(resolveSettleMs() * 0.35)));
      }
      const results = await execScriptFunc(
        tabId,
        (opsList) => {
          try {
            const fn = globalThis.__returnsReadPage;
            if (typeof fn !== "function") {
              return { __error: "Скрипт чтения страницы не загрузился" };
            }
            return fn(Array.isArray(opsList) ? opsList : []);
          } catch (e) {
            return { __error: String(e && e.message ? e.message : e) };
          }
        },
        [opsArg]
      );
      const raw = results[0]?.result;
      if (raw && raw.__error) {
        continue;
      }
      if (raw?.unsupportedTransitBox) {
        return raw;
      }
      const score = snapshotScore(raw);
      if (score > bestScore) {
        best = raw;
        bestScore = score;
      }
      if (snapshotLooksFull(raw)) {
        return raw;
      }
    }
    return best;
  }

  async function reloadArticlePage() {
    await new Promise((resolve, reject) => {
      chrome.tabs.reload(tabId, {}, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  
  
  const MAX_PAGE_CYCLES = 2;
  let raw = null;
  for (let cycle = 0; cycle < MAX_PAGE_CYCLES; cycle++) {
    await waitIfPaused();
    if (isAbortRequested()) {
      throw new Error("Остановлено");
    }
    const tNav = Date.now();
    if (cycle === 0) {
      await waitIfPaused();
      await new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, { url }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
      await waitUntilArticlePage(
        tabId,
        articleId,
        PAGE_LOAD_TIMEOUT_MS,
        isAbortRequested,
        isPauseRequested
      );
    } else {
      await waitIfPaused();
      await reloadArticlePage();
      await waitUntilArticlePage(
        tabId,
        articleId,
        PAGE_LOAD_TIMEOUT_MS,
        isAbortRequested,
        isPauseRequested
      );
    }
    if (perf) perf.msNavigate = (perf.msNavigate || 0) + (Date.now() - tNav);

    await waitIfPaused();
    // Страница готова, когда на ней появились данные, а не когда истекла
    // фиксированная пауза. Замеры это показали в лоб: сама страница грузилась
    // ~270 мс, маркеры приходили следом почти мгновенно, а мы поверх этого
    // спали ещё ~900 мс — три четверти всего времени чтения уходило в пустую
    // паузу. Ждём маркеры и читаем сразу; неполный снапшот всё равно
    // перечитывается циклом ниже, и авто-скорость поднимет паузу, если начнёт
    // промахиваться.
    const tMarkers = Date.now();
    const markersFound = await waitForDataMarkers(
      tabId,
      MARKER_WAIT_MS,
      isAbortRequested,
      isPauseRequested
    );
    if (perf) {
      perf.msMarkers = (perf.msMarkers || 0) + (Date.now() - tMarkers);
      perf.cycles = cycle + 1;
      perf.markersFound = (perf.markersFound !== false) && markersFound;
    }
    await waitIfPaused();
    // Пауза остаётся только для случая, когда данных на странице так и нет:
    // либо она ещё рисуется, либо это редкий макет без наших маркеров.
    if (!markersFound) {
      const tSettle = Date.now();
      await sleep(resolveSettleMs() + cycle * 100);
      if (perf) perf.msSettle = (perf.msSettle || 0) + (Date.now() - tSettle);
      await waitIfPaused();
    }
    const tInject = Date.now();
    await execScriptFiles(tabId, ["page-scrape.js"]);
    if (perf) perf.msInject = (perf.msInject || 0) + (Date.now() - tInject);
    const tRead = Date.now();
    raw = await readSnapshotAfterInject();
    if (perf) perf.msRead = (perf.msRead || 0) + (Date.now() - tRead);
    if (raw?.unsupportedTransitBox || snapshotHasAnyData(raw)) {
      break;
    }
  }

  if (!raw || typeof raw !== "object") {
    throw new Error(`Пустой ответ со страницы (${articleId})`);
  }
  if (!raw.unsupportedTransitBox && !snapshotHasAnyData(raw)) {
    throw new Error(`Нет данных на странице после перезагрузки (${articleId})`);
  }
  return normalizeArticleSnapshot(raw, articleId, fallbackShipment);
}

// Единая нормализация сырого снапшота (и со страницы, и из API) в тот вид,
// который потребляет остальной код. Общая для обоих путей намеренно: так
// исключается расхождение из-за разной постобработки.
function normalizeArticleSnapshot(raw, articleId, fallbackShipment = "") {
  const src = raw && typeof raw === "object" ? raw : {};
  if (src.unsupportedTransitBox) {
    return {
      unsupportedTransitBox: true,
      price: 0,
      nomenclature: "",
      shipment: String(fallbackShipment || articleId || "").trim(),
      articleId: String(src.articleId || "").trim(),
      operationalWarehouse: "",
      operationalWarehouseSeen: false,
      deliveryScheme: "",
      formationWarehouse: "",
      owner: "",
      status: "",
      statusLozon: "",
      statusAlps: "",
    };
  }
  const priceNum = Number(src.price);
  const hasPriceValue =
    src.price != null && src.price !== "" && Number.isFinite(priceNum);
  const isTransit = Boolean(src.isTransitBox);
  const isC2C = Boolean(src.isC2C);
  return {
    price: hasPriceValue ? priceNum : 0,
    nomenclature: String(
      src.nomenclature || (isTransit ? "Транзитная коробка" : isC2C ? "C2C" : "")
    ),
    shipment: String(src.shipment || fallbackShipment || articleId || "").trim(),
    articleId: String(src.articleId || "").trim(),
    operationalWarehouse: String(src.operationalWarehouse || ""),
    operationalWarehouseSeen: Boolean(src.operationalWarehouseSeen),
    deliveryScheme: String(src.deliveryScheme || (isC2C ? "C2C" : "")),
    formationWarehouse: String(src.formationWarehouse || ""),
    owner: String(src.owner || ""),
    status: String(src.status || ""),
    statusLozon: String(src.statusLozon || ""),
    statusAlps: String(src.statusAlps || ""),
    unsupportedTransitBox: false,
  };
}

async function getResultsCache() {
  const { [RESULTS_CACHE_KEY]: cache } = await chrome.storage.local.get(RESULTS_CACHE_KEY);
  return cache && typeof cache === "object" ? cache : {};
}

const resultsCachePending = new Map();
let resultsCacheFlushChain = Promise.resolve();

function isLozonNumericId(v) {
  return /^\d{10,35}$/.test(String(v || "").trim());
}

function pruneResultsCacheInPlace(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= RESULTS_CACHE_MAX_ENTRIES) return cache;
  keys.sort((a, b) => {
    const ta = Number(cache[a]?.cachedAt) || 0;
    const tb = Number(cache[b]?.cachedAt) || 0;
    return ta - tb;
  });
  const drop = keys.length - RESULTS_CACHE_MAX_ENTRIES;
  for (let i = 0; i < drop; i++) {
    delete cache[keys[i]];
  }
  return cache;
}

function buildResultCacheEntry(row, id) {
  const lozonId = String(row.articleId || "").trim();
  const fetchId = String(row.fetchArticleId || "").trim();
  return {
    warehouse: String(row.warehouse || ""),
    operationalWarehouse: String(row.operationalWarehouse || ""),
    articleId: isLozonNumericId(lozonId) ? lozonId : lozonId || String(id || ""),
    fetchArticleId: fetchId || (!isLozonNumericId(id) ? String(id || "") : ""),
    nomenclature: String(row.nomenclature || ""),
    shipment: String(row.shipment || ""),
    price: Number(row.price) || 0,
    activeStatus: String(row.activeStatus || row.status || ""),
    deliveryScheme: String(row.deliveryScheme || ""),
    formationWarehouse: String(row.formationWarehouse || ""),
    owner: String(row.owner || ""),
    statusLozon: String(row.statusLozon || ""),
    statusAlps: String(row.statusAlps || ""),
    cachedAt: Date.now(),
  };
}

async function flushResultsCacheNow() {
  if (resultsCachePending.size === 0) return;
  const batch = new Map(resultsCachePending);
  resultsCachePending.clear();
  if (!batch.size) return;
  const cache = await getResultsCache();
  for (const [id, row] of batch) {
    cache[id] = row;
  }
  pruneResultsCacheInPlace(cache);
  await chrome.storage.local.set({ [RESULTS_CACHE_KEY]: cache });
}

function enqueueResultsCacheFlush() {
  resultsCacheFlushChain = resultsCacheFlushChain
    .catch(() => {})
    .then(() => flushResultsCacheNow());
  return resultsCacheFlushChain;
}

async function flushResultsCache(_force = false) {
  
  return enqueueResultsCacheFlush();
}

async function saveResultToCache(row) {
  const lozonId = String(row?.articleId || "").trim();
  const fetchId = String(row?.fetchArticleId || "").trim();
  if (!lozonId && !fetchId) return;
  const entry = buildResultCacheEntry(row, lozonId || fetchId);
  if (lozonId) resultsCachePending.set(lozonId, entry);
  if (fetchId && fetchId !== lozonId) {
    
    resultsCachePending.set(fetchId, { ...entry });
  }
  if (!lozonId && fetchId) resultsCachePending.set(fetchId, entry);
  await enqueueResultsCacheFlush();
}

async function loadCachedResultsForIds(ids) {
  const cache = await getResultsCache();
  const out = [];
  for (const rawId of ids || []) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const row = cache[id];
    if (!row) continue;
    const cachedArticleId = String(row.articleId || "").trim();
    out.push({
      ...row,
      fetchArticleId: String(row.fetchArticleId || id).trim(),
      
      articleId: isLozonNumericId(cachedArticleId) ? cachedArticleId : cachedArticleId || id,
    });
  }
  return out;
}

function isValidArticleIdForFetch(articleId) {
  return typeof globalThis.__returnsLooksLikeId === "function"
    ? globalThis.__returnsLooksLikeId(articleId)
    : false;
}

function getUnsupportedShipmentSkipReason(row) {
  return typeof globalThis.__returnsGetUnsupportedShipmentSkipReason === "function"
    ? String(globalThis.__returnsGetUnsupportedShipmentSkipReason(row) || "")
    : "";
}

function pushUnsupportedTypeSkip(job, articleId) {
  if (!Array.isArray(job.skippedOpsWarehouse)) job.skippedOpsWarehouse = [];
  job.skippedOpsWarehouse.push(`Неподдерживаемый тип: ${articleId}`);
}

function buildJobResultRow(item, data) {
  const fetchId = String(item.articleId || "").trim();
  const scrapedId = String(data.articleId || "").trim();
  
  const articleId = /^\d{10,35}$/.test(scrapedId) ? scrapedId : scrapedId || fetchId;
  return {
    warehouse: item.warehouse,
    operationalWarehouse: String(data.operationalWarehouse || item.operationalWarehouse || ""),
    articleId,
    fetchArticleId: fetchId,
    nomenclature: data.nomenclature,
    shipment: data.shipment,
    price: data.price,
    activeStatus: String(data.status || ""),
    deliveryScheme: String(data.deliveryScheme || ""),
    formationWarehouse: String(data.formationWarehouse || ""),
    owner: String(data.owner || ""),
    statusLozon: String(data.statusLozon || ""),
    statusAlps: String(data.statusAlps || ""),
  };
}

async function getOpsWarehousesFromPrefs() {
  const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
  if (!Array.isArray(prefs?.opsWarehouses)) return [];
  return prefs.opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean);
}

function countJobProcessed(job) {
  const resultsN = Array.isArray(job?.results) ? job.results.length : Number(job?.resultsCount) || 0;
  const errorsN = Array.isArray(job?.errors) ? job.errors.length : Number(job?.errorsCount) || 0;
  const skippedOpsN = Array.isArray(job?.skippedOpsWarehouse)
    ? job.skippedOpsWarehouse.length
    : Number(job?.skippedOpsWarehouseCount) || 0;
  return resultsN + errorsN + skippedOpsN;
}

function getJobPlannedTotal(job) {
  
  const toFetchRows = Number(job?.inputStats?.toFetchRows);
  if (Number.isFinite(toFetchRows) && toFetchRows > 0) return toFetchRows;
  const planned = Number(job?.plannedTotal);
  if (Number.isFinite(planned) && planned > 0) return planned;
  const fromCount = Number(job?.toFetchCount);
  if (Number.isFinite(fromCount) && fromCount > 0) return fromCount;
  if (Array.isArray(job?.toFetch) && job.toFetch.length > 0) return job.toFetch.length;
  const remaining = Number(job?.inputStats?.remainingRows ?? job?.remainingCount);
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  return 0;
}

function getJobTotalToFetch(job) {
  return getJobPlannedTotal(job);
}

function isJobWorkComplete(job) {
  const total = getJobTotalToFetch(job);
  if (total <= 0) return false;
  return countJobProcessed(job) >= total;
}

function finalizeJobIfComplete(job, toFetchLength) {
  const total =
    Number(toFetchLength) > 0
      ? Number(toFetchLength)
      : getJobTotalToFetch(job);
  if (total <= 0) return false;
  if (countJobProcessed(job) < total) return false;
  job.phase = "done";
  job.currentArticleId = null;
  job.currentIndex = total;
  return true;
}

async function rebuildToFetchFromSourceForJob(mode, job) {
  if (!globalThis.__goodsAuditCache || !globalThis.__returnsParseSourceRows) return null;
  try {
    const entry = await globalThis.__goodsAuditCache.loadSourceCache(mode);
    const sourceText = String(entry?.text || "").trim();
    if (!sourceText) return null;
    const parsed = globalThis.__returnsParseSourceRows(sourceText, false);
    const byArticle = new Map();
    for (const row of parsed.rows) {
      const { articleId } = row;
      if (byArticle.has(articleId)) continue;
      byArticle.set(articleId, row);
    }
    const processedIds = new Set();
    const addId = (raw) => {
      const id = String(raw || "").trim();
      if (id && id !== "-") processedIds.add(id);
    };
    const results = Array.isArray(job?.results) ? job.results : [];
    const errors = Array.isArray(job?.errors) ? job.errors : [];
    for (const row of results) {
      addId(row?.articleId);
      addId(row?.fetchArticleId);
    }
    for (const row of errors) {
      addId(row?.articleId);
      addId(row?.fetchArticleId);
    }
    
    
    try {
      const processed = await getProcessedSet();
      for (const id of processed) addId(id);
    } catch {
    }
    const toFetch = [];
    for (const row of byArticle.values()) {
      const { warehouse, articleId, operationalWarehouse, shipmentSource, postingType } = row;
      if (processedIds.has(String(articleId || "").trim())) continue;
      const item = {
        warehouse,
        articleId,
        operationalWarehouse,
        shipmentSource: String(shipmentSource || ""),
        postingType: String(postingType || ""),
      };
      if (getUnsupportedShipmentSkipReason(item)) continue;
      toFetch.push(item);
    }
    return toFetch;
  } catch {
    return null;
  }
}

async function loadSourceArticleIdsForMode(mode = "file") {
  if (!globalThis.__goodsAuditCache || !globalThis.__returnsParseSourceRows) return [];
  try {
    const entry = await globalThis.__goodsAuditCache.loadSourceCache(mode);
    const sourceText = String(entry?.text || "").trim();
    if (!sourceText) return [];
    const parsed = globalThis.__returnsParseSourceRows(sourceText, false);
    const ids = [];
    const seen = new Set();
    for (const row of parsed.rows || []) {
      const id = String(row?.articleId || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

async function hydrateResultsForResume(job, sourceArticleIds = null) {
  let results = Array.isArray(job?.results) ? job.results.map((row) => ({ ...row })) : [];
  let errors = Array.isArray(job?.errors) ? job.errors.map((row) => ({ ...row })) : [];
  const needResults = results.length === 0 && (Number(job?.resultsCount) || 0) > 0;
  if (!needResults) return { results, errors };

  
  const scope = [
    ...new Set(
      (Array.isArray(sourceArticleIds) ? sourceArticleIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    ),
  ];
  if (!scope.length) return { results, errors };

  try {
    const mem = await getProcessedSet();
    const ids = scope.filter((id) => mem.has(id));
    if (!ids.length) return { results, errors };
    const cached = await loadCachedResultsForIds(ids);
    if (!cached.length) return { results, errors };

    const out = [];
    const seen = new Set();
    for (const row of cached) {
      const articleId = String(row?.articleId || "").trim();
      const fetchId = String(row?.fetchArticleId || "").trim();
      const dedupeKey = articleId || fetchId;
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      if (fetchId && fetchId !== dedupeKey && seen.has(fetchId)) continue;
      seen.add(dedupeKey);
      if (fetchId) seen.add(fetchId);
      out.push(row);
    }
    results = out;
  } catch {
  }
  return { results, errors };
}

async function tryResumePausedJob(mode = "file") {
  const key = normalizeSourceMode(mode);
  if (jobClearedModes[key]) return;
  if (resumeLocks[key]) return resumeLocks[key];

  resumeLocks[key] = (async () => {
    const state = getRunState(key);
    if (state.running) return;
    if (jobClearedModes[key]) return;

    const jobKey = getJobKeyByMode(key);
    const { [jobKey]: stored } = await chrome.storage.local.get(jobKey);
    const job = state.liveJob || stored;
    if (!job || (job.phase !== "paused" && job.phase !== "running")) return;

    if (isJobWorkComplete(job)) {
      finalizeJobIfComplete(job);
      await writeJobToStorage(job, key);
      return;
    }

    let fullToFetch = Array.isArray(job.toFetch) ? job.toFetch : null;
    if (!fullToFetch?.length) {
      fullToFetch = await rebuildToFetchFromSourceForJob(key, job);
    }
    if (!fullToFetch?.length) {
      if (isJobWorkComplete(job)) {
        finalizeJobIfComplete(job);
        await writeJobToStorage(job, key);
      }
      return;
    }

    const sourceArticleIds = await loadSourceArticleIdsForMode(key);
    const hydrated = await hydrateResultsForResume(job, sourceArticleIds);
    const results = hydrated.results;
    const errors = hydrated.errors;
    const processedIds = new Set();
    for (const row of results) {
      const id = String(row?.articleId || "").trim();
      if (id) processedIds.add(id);
      const fetchId = String(row?.fetchArticleId || "").trim();
      if (fetchId) processedIds.add(fetchId);
    }
    for (const row of errors) {
      const id = String(row?.articleId || "").trim();
      if (id && id !== "-") processedIds.add(id);
      const fetchId = String(row?.fetchArticleId || "").trim();
      if (fetchId) processedIds.add(fetchId);
    }
    try {
      const mem = await getProcessedSet();
      for (const id of mem) processedIds.add(String(id));
    } catch {
    }

    const remaining = fullToFetch.filter((row) => !processedIds.has(String(row?.articleId || "").trim()));
    const plannedTotal = getJobPlannedTotal(job) || fullToFetch.length;
    if (!remaining.length) {
      job.results = results;
      job.errors = errors;
      if (!finalizeJobIfComplete(job, plannedTotal)) {
        job.phase = "done";
        job.currentArticleId = null;
        job.currentIndex = countJobProcessed(job);
      }
      await writeJobToStorage(job, key);
      return;
    }

    state.running = true;
    state.abortRequested = false;
    state.pauseRequested = false;
    await ensureKeepAliveAlarm();

    try {
      
      let opsWarehouses = Array.isArray(job.opsWarehouses)
        ? job.opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      if (!opsWarehouses.length) {
        opsWarehouses = await getOpsWarehousesFromPrefs();
      }
      await runJobFromState({
        sourceMode: key,
        sourceName: job.sourceName || "",
        manualThreads: parseManualThreads(job.manualThreads),
        aggressiveMode: job.aggressiveMode === true,
        opsWarehouses,
        toFetch: remaining,
        skippedMem: job.skippedMem || [],
        skippedDupSource: job.skippedDupSource || [],
        skippedOpsWarehouse: job.skippedOpsWarehouse || [],
        inputStats: {
          ...(job.inputStats && typeof job.inputStats === "object" ? job.inputStats : {}),
          toFetchRows: plannedTotal,
        },
        initialResults: results,
        initialErrors: errors,
        initialToFetchTotal: plannedTotal,
      });
    } finally {
      state.running = false;
    }
  })().finally(() => {
    resumeLocks[key] = null;
  });

  return resumeLocks[key];
}

async function getAggressiveModeEnabled() {
  const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
  return prefs?.aggressiveMode === true;
}

function formatMoneyLabel(n) {
  return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
}

async function getPriceThresholdsFromPrefs() {
  const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
  const parsedUpper = Number(prefs?.priceThreshold);
  const upper = Number.isFinite(parsedUpper) && parsedUpper >= 0 ? parsedUpper : 10000;
  const parsedMin = Number(prefs?.minPriceThreshold);
  const min = Number.isFinite(parsedMin) ? Math.max(0, parsedMin) : 0;
  return { upper, min };
}

function countResultBands(results, upper, min) {
  let ge = 0;
  let lt = 0;
  for (const r of results || []) {
    const p = Number(r?.price);
    if (Number.isNaN(p) || p < min) continue;
    if (p >= upper) ge += 1;
    else lt += 1;
  }
  return { ge, lt };
}

async function buildDoneToastMessage(job) {
  const resN = Array.isArray(job?.results) ? job.results.length : 0;
  const errN = Array.isArray(job?.errors) ? job.errors.length : 0;
  const { upper, min } = await getPriceThresholdsFromPrefs();
  const { ge, lt } = countResultBands(job?.results, upper, min);
  const upperFmt = formatMoneyLabel(upper);
  return (
    `Готово. «Результат» в расширении.\n` +
    `Успешно: ${resN}, ошибок: ${errN}.\n` +
    `≥${upperFmt} ₽: ${ge}, <${upperFmt} ₽: ${lt}`
  );
}

async function emitActiveTabsToast(message) {
  await emitSystemNotification(message);
}

const NOTIFICATION_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function createNotification(id, options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.notifications.create(id, options, (nid) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "notification failed"));
          return;
        }
        resolve(nid || id);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function emitSystemNotification(message) {
  const text = String(message || "").trim();
  if (!text || !chrome.notifications?.create) return false;
  const base = {
    type: "basic",
    title: "GoodsAudit",
    message: text.length > 180 ? `${text.slice(0, 177)}…` : text,
    priority: 2,
  };
  const id = `goods-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await createNotification(id, { ...base, iconUrl: chrome.runtime.getURL("icon.png") });
    return true;
  } catch {
  }
  try {
    await createNotification(`${id}-fb`, { ...base, iconUrl: NOTIFICATION_ICON_DATA_URL });
    return true;
  } catch {
    return false;
  }
}

function isTrustedExtensionSender(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  const url = String(sender.url || "");
  if (!url) return true;
  return url.startsWith(chrome.runtime.getURL(""));
}

// Сколько вкладок держим под чтение страниц, когда быстрое чтение работает.
// Через API вкладка нужна только чтобы выполнить fetch в контексте страницы —
// навигации там нет, поэтому одной сессионной вкладки хватает на любое число
// одновременных чтений. Страница остаётся нужна лишь на пробах, сверках и
// фолбэках, а их после включения типа единицы.
const API_MODE_PAGE_TABS = 2;

// Пул вкладок живёт в api-mapping.js — там он покрыт тестами. Без него
// прогон невозможен, поэтому падаем понятно, а не «undefined is not a
// function» где-то в середине.
const createTabPool =
  globalThis.__gaApiMapping?.createTabPool ||
  (() => {
    throw new Error("Не загрузился api-mapping.js — пул вкладок недоступен");
  });

async function openWorkerWindow(threadCount, mode = "file", aggressiveMode = false) {
  const n = Math.max(1, Math.min(MANUAL_THREADS_HARD_CAP, Math.floor(Number(threadCount) || 1)));
  const bringToFront = Boolean(aggressiveMode);
  const win = await new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: "about:blank",
        focused: bringToFront,
        type: "normal",
        width: 440,
        height: 320,
        left: 48,
        top: 48,
      },
      (w) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(w);
      }
    );
  });

  const winId = win.id;
  await sleep(80);

  for (let i = 0; i < n - 1; i++) {
    await new Promise((resolve, reject) => {
      chrome.tabs.create(
        { windowId: winId, url: "about:blank", active: false },
        (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(tab);
        }
      );
    });
  }

  await sleep(120);
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ windowId: winId }, resolve);
  });
  const tabIds = tabs
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((t) => t.id)
    .filter((id) => id != null);

  if (tabIds.length < n) {
    throw new Error(
      `Окно парсинга: ожидалось ${n} вкладок, получено ${tabIds.length}`
    );
  }
  const tabIdsFinal = tabIds.slice(0, n);
  await Promise.all(tabIdsFinal.map((id) => forceTabPerformanceMode(id).catch(() => {})));
  await forceWindowPerformanceMode(winId, bringToFront).catch(() => {});

  const state = getRunState(mode);
  state.workerWindowId = winId;
  if (state.liveJob) {
    state.liveJob.workerWindowId = winId;
    state.liveJob.workerTabIds = tabIdsFinal;
  }
  touchWorkerHeartbeat(mode);
  await persistWorkerWindowMeta(mode, winId, tabIdsFinal);
  startWorkerBoost(mode, winId, tabIdsFinal, bringToFront);
  await ensureKeepAliveAlarm();
  return { windowId: winId, tabIds: tabIdsFinal };
}

async function getProcessedSet() {
  const { [PROCESSED_KEY]: arr } = await chrome.storage.local.get(PROCESSED_KEY);
  return new Set(Array.isArray(arr) ? arr.map((x) => String(x || "").trim()).filter(Boolean) : []);
}

async function flushProcessedIds(force = false) {
  if (!force && processedWriteBuffer.size === 0) return;
  const set = await getProcessedSet();
  for (const id of processedWriteBuffer) set.add(id);
  processedWriteBuffer.clear();
  if (processedFlushTimer) {
    clearTimeout(processedFlushTimer);
    processedFlushTimer = null;
  }
  await chrome.storage.local.set({ [PROCESSED_KEY]: [...set] });
}

async function addProcessedIds(ids) {
  for (const id of ids || []) {
    const s = String(id || "").trim();
    if (s) processedWriteBuffer.add(s);
  }
  if (processedFlushTimer) return;
  processedFlushTimer = setTimeout(() => {
    processedFlushTimer = null;
    void flushProcessedIds();
  }, 2500);
}

function capStringList(list, cap = JOB_STORAGE_LIST_CAP) {
  if (!Array.isArray(list) || list.length <= cap) {
    return { list: Array.isArray(list) ? list : [], truncated: 0 };
  }
  return { list: list.slice(0, cap), truncated: list.length - cap };
}

function slimJobForStorage(job) {
  const slim = { ...job };
  if (Array.isArray(job?.toFetch)) slim.toFetch = job.toFetch.slice();
  if (Array.isArray(job?.results)) {
    slim.results = job.results.map((r) => {
      if (!r || typeof r !== "object") return r;
      if (!Object.prototype.hasOwnProperty.call(r, "sourceCells")) return { ...r };
      const copy = { ...r };
      delete copy.sourceCells;
      return copy;
    });
  }
  if (Array.isArray(job?.errors)) {
    slim.errors = job.errors.map((e) => {
      if (!e || typeof e !== "object") return e;
      if (!Object.prototype.hasOwnProperty.call(e, "sourceCells")) return { ...e };
      const copy = { ...e };
      delete copy.sourceCells;
      return copy;
    });
  }
  if (Array.isArray(job?.skippedMem)) slim.skippedMem = job.skippedMem.slice();
  if (Array.isArray(job?.skippedDupSource)) slim.skippedDupSource = job.skippedDupSource.slice();
  if (Array.isArray(job?.skippedOpsWarehouse)) {
    slim.skippedOpsWarehouse = job.skippedOpsWarehouse.slice();
  }
  if (Array.isArray(job?.opsWarehouses)) slim.opsWarehouses = job.opsWarehouses.slice();
  if (Array.isArray(job?.workerTabIds)) slim.workerTabIds = job.workerTabIds.slice();
  if (job?.inputStats && typeof job.inputStats === "object") {
    slim.inputStats = { ...job.inputStats };
  }

  const planned = getJobPlannedTotal(slim);
  if (planned > 0) {
    slim.plannedTotal = planned;
    slim.toFetchCount = planned;
  }
  if (Array.isArray(slim.toFetch)) {
    slim.remainingCount = slim.toFetch.length;
    if (!slim.plannedTotal) slim.toFetchCount = slim.toFetch.length;
    if (slim.phase === "running" || slim.phase === "done" || slim.phase === "aborted") {
      delete slim.toFetch;
    }
  }
  if (slim.phase === "running") {
    slim.resultsCount = Array.isArray(slim.results) ? slim.results.length : Number(slim.resultsCount) || 0;
    slim.errorsCount = Array.isArray(slim.errors) ? slim.errors.length : Number(slim.errorsCount) || 0;
    if (Array.isArray(slim.skippedOpsWarehouse)) {
      slim.skippedOpsWarehouseCount = slim.skippedOpsWarehouse.length;
    }
    
    
    delete slim.results;
  } else if (slim.phase === "done" || slim.phase === "aborted" || slim.phase === "paused") {
    if (Array.isArray(slim.results)) {
      slim.resultsCount = slim.results.length;
    }
    if (Array.isArray(slim.errors)) {
      slim.errorsCount = slim.errors.length;
    }
  }
  const skippedMem = capStringList(slim.skippedMem);
  slim.skippedMem = skippedMem.list;
  if (skippedMem.truncated) slim.skippedMemTruncated = skippedMem.truncated;
  const skippedDup = capStringList(slim.skippedDupSource);
  slim.skippedDupSource = skippedDup.list;
  if (skippedDup.truncated) slim.skippedDupSourceTruncated = skippedDup.truncated;
  const skippedOps = capStringList(slim.skippedOpsWarehouse);
  slim.skippedOpsWarehouse = skippedOps.list;
  if (skippedOps.truncated) slim.skippedOpsWarehouseTruncated = skippedOps.truncated;
  const errors = capStringList(slim.errors);
  slim.errors = errors.list;
  if (errors.truncated) slim.errorsTruncated = errors.truncated;
  return slim;
}

async function writeJobToStorage(job, mode = "file") {
  const key = normalizeSourceMode(mode);
  
  if (jobClearedModes[key]) return;
  const jobKey = getJobKeyByMode(key);
  job.updatedAt = Date.now();
  const slim = slimJobForStorage(job);
  if (slim.workerWindowId == null) {
    const state = getRunState(key);
    if (state.workerWindowId != null) {
      slim.workerWindowId = Number(state.workerWindowId);
    } else {
      try {
        const prev = (await chrome.storage.local.get(jobKey))[jobKey];
        if (prev?.workerWindowId != null && (slim.phase === "running" || slim.phase === "paused")) {
          slim.workerWindowId = prev.workerWindowId;
          if (Array.isArray(prev.workerTabIds) && !Array.isArray(slim.workerTabIds)) {
            slim.workerTabIds = prev.workerTabIds;
          }
        }
      } catch {
      }
    }
  }
  if ((slim.phase === "done" || slim.phase === "aborted") && slim.workerWindowId != null) {
    delete slim.workerWindowId;
    delete slim.workerTabIds;
  }
  if (jobClearedModes[key]) return;
  await chrome.storage.local.set({ [jobKey]: slim });
}

async function flushPersistJob(mode, force = false) {
  const key = normalizeSourceMode(mode);
  const q = persistQueues[key];
  if (!q.pending) return;
  if (jobClearedModes[key]) {
    q.pending = null;
    q.itemCounter = 0;
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    return;
  }
  const { job, mode: jobMode } = q.pending;
  q.pending = null;
  q.itemCounter = 0;
  q.lastAt = Date.now();
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  await writeJobToStorage(job, jobMode);
  if (force) return;
}

function schedulePersistFlush(mode) {
  const key = normalizeSourceMode(mode);
  const q = persistQueues[key];
  if (jobClearedModes[key]) return;
  if (q.timer) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    void flushPersistJob(key, false);
  }, PERSIST_THROTTLE_MS);
}

async function persistJob(job, mode = "file", opts = {}) {
  const force = opts.force === true;
  const key = normalizeSourceMode(mode);
  if (jobClearedModes[key]) return;
  const q = persistQueues[key];
  q.pending = { job, mode };
  q.itemCounter += 1;
  const now = Date.now();
  if (force || q.itemCounter >= PERSIST_EVERY_ITEMS || now - q.lastAt >= PERSIST_THROTTLE_MS) {
    await flushPersistJob(key, force);
    return;
  }
  schedulePersistFlush(key);
}

function queryTabsInWindow(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId }, (tabs) => resolve(Array.isArray(tabs) ? tabs : []));
  });
}

async function setWindowTabsAutoDiscardable(windowId, value) {
  const tabs = await queryTabsInWindow(windowId);
  await Promise.all(
    tabs
      .map((tab) => tab?.id)
      .filter((id) => id != null)
      .map((id) => updateTab(id, { autoDiscardable: Boolean(value) }).catch(() => {}))
  );
  return tabs;
}

async function markJobAborted(mode = "file", reason, opts = {}) {
  const jobKey = getJobKeyByMode(mode);
  const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
  if (!job) return;
  if (job.phase !== "running" && job.phase !== "paused") return;
  job.phase = "aborted";
  job.currentArticleId = null;
  job.abortRequested = true;
  const asError = opts.asError !== false;
  if (reason) {
    job.stopReason = String(reason);
    if (asError) {
      job.errors = Array.isArray(job.errors) ? job.errors : [];
      job.errors.push({ articleId: "-", message: String(reason) });
    }
  }
  await persistJob(job, mode, { force: true });
}

async function isWorkerWindowAlive(mode = "file") {
  const wid = await hydrateWorkerWindowId(mode);
  return wid != null;
}

async function recoverIfOrphanedRun(mode = "file") {
  const state = getRunState(mode);
  if (state.running) return;
  const key = normalizeSourceMode(mode);
  if (jobClearedModes[key]) return;
  const jobKey = getJobKeyByMode(key);
  const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
  if (!job || (job.phase !== "running" && job.phase !== "paused")) return;

  await hydrateWorkerWindowId(mode);
  const alive = await isWorkerWindowAlive(mode);
  if (alive) {
    return;
  }

  stopWorkerBoost(mode);
  state.workerWindowId = null;
  await clearPersistedWorkerWindowMeta(mode);
  if (job.phase === "running") {
    job.phase = "paused";
    job.currentArticleId = null;
    job.stopReason =
      job.stopReason ||
      "Окно парсинга было закрыто системой. Обработка будет продолжена автоматически.";
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ [jobKey]: job });
  }
  state.pauseRequested = false;
  state.abortRequested = false;
  state.running = false;
  await ensureKeepAliveAlarm();
}

async function abortActiveRunAsStopped(mode = "file", reason = "Окна парсинга закрыты пользователем.") {
  const state = getRunState(mode);
  state.abortRequested = true;
  state.pauseRequested = false;
  stopWorkerBoost(mode);
  state.workerWindowId = null;
  await clearPersistedWorkerWindowMeta(mode);
  await markJobAborted(mode, reason);
  state.running = false;
  await clearKeepAliveAlarmIfIdle();
}

async function reconcileActiveJobsAfterWake() {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = (async () => {
    let hasActiveJob = false;
    const resumeModes = [];
    for (const mode of ["file", "text"]) {
      const state = getRunState(mode);
      if (state.running) {
        touchWorkerHeartbeat(mode);
        hasActiveJob = true;
        continue;
      }
      const jobKey = getJobKeyByMode(mode);
      const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
      if (!job || (job.phase !== "running" && job.phase !== "paused")) continue;
      hasActiveJob = true;

      await hydrateWorkerWindowId(mode);
      const alive = await isWorkerWindowAlive(mode);

      if (!alive) {
        await recoverIfOrphanedRun(mode);
        const { [jobKey]: recovered } = await chrome.storage.local.get(jobKey);
        if (
          recovered &&
          !isJobWorkComplete(recovered) &&
          (recovered.phase === "running" ||
            (recovered.phase === "paused" && !recovered.userPaused && recovered.stopReason))
        ) {
          resumeModes.push(mode);
        }
        continue;
      }

      if (
        job.phase === "running" ||
        (job.phase === "paused" && !job.userPaused && job.stopReason)
      ) {
        resumeModes.push(mode);
      }
    }
    if (hasActiveJob) await ensureKeepAliveAlarm();
    await clearKeepAliveAlarmIfIdle();
    for (const mode of resumeModes) {
      const now = Date.now();
      if (now - (lastAutoResumeAt[mode] || 0) < 4000) continue;
      lastAutoResumeAt[mode] = now;
      void tryResumePausedJob(mode).catch(() => {});
    }
  })().finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
}

async function runJobFromState(startPayload) {
  const {
    sourceMode,
    sourceName,
    aggressiveMode,
    toFetch,
    skippedMem,
    skippedDupSource,
    inputStats,
    opsWarehouses,
    skippedOpsWarehouse,
    initialResults,
    initialErrors,
    initialToFetchTotal,
  } = startPayload;
  const mode = normalizeSourceMode(sourceMode);
  const state = getRunState(mode);

  await closeWorkerResources(mode);
  state.abortRequested = false;
  state.pauseRequested = false;
  touchWorkerHeartbeat(mode);
  await ensureKeepAliveAlarm();

  const manualThreads = parseManualThreads(startPayload.manualThreads);
  const threads = manualThreads
    ? Math.max(1, Math.min(manualThreads, Math.max(1, toFetch.length)))
    : computeAutoThreads(toFetch.length);
  const speedCtl = createSpeedController(threads, { fixedThreads: manualThreads > 0 });
  const runConfig = {
    aggressiveMode: aggressiveMode === true,
  };
  state.activeRunConfig = runConfig;

  const plannedTotal =
    Number(initialToFetchTotal) > 0
      ? Number(initialToFetchTotal)
      : Number(inputStats?.toFetchRows) > 0
        ? Number(inputStats.toFetchRows)
        : toFetch.length +
          (Array.isArray(initialResults) ? initialResults.length : 0) +
          (Array.isArray(initialErrors) ? initialErrors.length : 0);

  const opsListForJob = Array.isArray(opsWarehouses)
    ? opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  // Быстрое чтение через API: общий на все окна ограничитель нагрузки.
  const apiPrefs = await getApiReadPrefs();
  const requestPacer =
    apiPrefs.enabled && globalThis.__gaApiMapping
      ? globalThis.__gaApiMapping.createRequestPacer(apiPrefs.rps)
      : null;
  const readStats = { api: 0, dom: 0 };
  // Состояние быстрого чтения общее на все потоки: типы проверяются один раз
  // на прогон, а не в каждом окне заново, и статистика не перезаписывается.
  const apiShared = {
    sharedChannels: new Map(),
    sharedCounters: new Map(),
    sharedDiagnostics: new Map(),
    sharedFallbacks: new Map(),
    sharedTypeCache: new Map(),
    // Пробу по типу делает один поток, остальные ждут её исхода.
    sharedProbeLocks: new Map(),
  };
  const apiUnavailableReason = !apiPrefs.enabled
    ? "выключено в настройках"
    : !globalThis.__gaApiReader
      ? "модуль быстрого чтения не загрузился"
      : "";
  let apiLogShown = false;
  const logApi = (msg) => {
    try {
      console.log(`[GoodsAudit/${mode}] ${msg}`);
    } catch {}
  };

  let job = {
    phase: "running",
    abortRequested: false,
    sourceMode: sourceMode === "text" ? "text" : "file",
    sourceName,
    autoSpeed: manualThreads === 0,
    manualThreads,
    apiReadEnabled: apiPrefs.enabled === true,
    speed: speedCtl.snapshot(),
    aggressiveMode: runConfig.aggressiveMode,
    threads,
    
    opsWarehouses: opsListForJob,
    toFetch,
    plannedTotal,
    skippedMem,
    skippedDupSource,
    skippedOpsWarehouse: Array.isArray(skippedOpsWarehouse) ? [...skippedOpsWarehouse] : [],
    inputStats: {
      ...(inputStats && typeof inputStats === "object" ? inputStats : {}),
      ...(plannedTotal > 0 ? { toFetchRows: plannedTotal } : {}),
    },
    currentIndex:
      (Array.isArray(initialResults) ? initialResults.length : 0) +
      (Array.isArray(initialErrors) ? initialErrors.length : 0) +
      (Array.isArray(skippedOpsWarehouse) ? skippedOpsWarehouse.length : 0),
    currentArticleId: null,
    results: Array.isArray(initialResults) ? initialResults.map((row) => ({ ...row })) : [],
    errors: Array.isArray(initialErrors) ? initialErrors.map((row) => ({ ...row })) : [],
  };
  state.liveJob = job;
  await persistJob(job, mode, { force: true });

  try {
    if (toFetch.length === 0) {
      job.phase = "done";
      job.currentArticleId = null;
      job.currentIndex = job.results.length + job.errors.length + (job.skippedOpsWarehouse?.length || 0);
      await persistJob(job, mode, { force: true });
      return;
    }

    // Быстрое чтение развязано со вкладками: запросы к API выполняются в
    // контексте одной сессионной вкладки (навигации там нет, поэтому она
    // обслуживает любое число одновременных чтений), а страницы читает
    // маленький пул. «Потоки» с этого момента — параллельность чтения, а не
    // число окон: вкладок 1 + 2 вместо «вкладка на поток».
    const apiReadReady = apiPrefs.enabled && Boolean(globalThis.__gaApiReader);
    const pageTabsAtStart = apiReadReady ? Math.min(API_MODE_PAGE_TABS, threads) : threads;
    const { tabIds } = await openWorkerWindow(
      apiReadReady ? pageTabsAtStart + 1 : threads,
      mode,
      runConfig.aggressiveMode
    );
    const sessionTabId = apiReadReady ? tabIds[0] : null;
    const pagePool = createTabPool(apiReadReady ? tabIds.slice(1) : tabIds.slice());
    const ITEM_HARD_TIMEOUT_MS = 60 * 60 * 1000;

    let nextAssign = 0;
    function takeNext() {
      if (nextAssign >= toFetch.length) return null;
      return toFetch[nextAssign++];
    }

    async function respawnWorkerTab(tabId) {
      const winId = state.workerWindowId;
      if (winId == null) throw new Error("Окно парсинга закрыто");
      const nextTab = await new Promise((resolve, reject) => {
        chrome.tabs.create({ windowId: winId, url: "about:blank", active: false }, (tab) => {
          if (chrome.runtime.lastError || !tab?.id) {
            reject(new Error(chrome.runtime.lastError?.message || "Не удалось создать новую вкладку"));
            return;
          }
          resolve(tab);
        });
      });
      const nextTabId = nextTab.id;
      await forceTabPerformanceMode(nextTabId).catch(() => {});
      const idx = tabIds.indexOf(tabId);
      if (idx >= 0) tabIds[idx] = nextTabId;
      pagePool.replace(tabId, nextTabId);
      if (state.boostTimerId != null) {
        startWorkerBoost(mode, winId, tabIds, runConfig.aggressiveMode);
      }
      await new Promise((resolve) => {
        chrome.tabs.remove(tabId, () => resolve());
      });
      return nextTabId;
    }

    const totalWorkItems = plannedTotal > 0 ? plannedTotal : toFetch.length;

    // perf принадлежит объекту, а не потоку, но класть его в сам item нельзя:
    // toFetch уезжает в storage вместе с задачей.
    const perfByItem = new WeakMap();
    const jobOpsList = () =>
      Array.isArray(job.opsWarehouses) ? job.opsWarehouses : opsListForJob;

    // Последняя вкладка, на которой действительно грузилась страница: свежие
    // токены появляются именно там, поэтому снимаем заголовки и с неё тоже.
    let lastPageTabId = null;

    // Сессионную вкладку браузер может выгрузить — тогда запросы из неё не
    // уйдут. Проверяем не на каждый запрос, а раз в несколько секунд.
    let sessionTabCheckedAt = 0;
    async function ensureSessionTabAlive() {
      if (sessionTabId == null) return;
      const now = Date.now();
      if (now - sessionTabCheckedAt < 5000) return;
      sessionTabCheckedAt = now;
      await ensureTabNotDiscarded(sessionTabId).catch(() => {});
    }

    async function domScrapeViaPool(it) {
      let tabId = await pagePool.acquire();
      lastPageTabId = tabId;
      try {
        await ensureTabNotDiscarded(tabId).catch(() => {});
        if (runConfig.aggressiveMode) {
          await bringWorkerTabToFront(state.workerWindowId, tabId).catch(() => {});
        }
        return await withTimeout(
          scrapeArticleOnTab(
            tabId,
            it.articleId,
            () => speedCtl.getSettleMs(),
            jobOpsList(),
            it.shipmentSource || "",
            () => state.abortRequested,
            () => state.pauseRequested,
            perfByItem.get(it) || null
          ),
          ITEM_HARD_TIMEOUT_MS,
          `Таймаут обработки в потоке (${Math.round(ITEM_HARD_TIMEOUT_MS / 1000)}с)`
        );
      } catch (e) {
        // Зависшую вкладку меняем на свежую — иначе она отравит весь пул.
        if (String(e?.message || e).includes("Таймаут обработки в потоке")) {
          try {
            tabId = await respawnWorkerTab(tabId);
          } catch {}
        }
        throw e;
      } finally {
        pagePool.release(tabId);
      }
    }

    // Переучивание токена общее: сессионную вкладку незачем гонять по кругу
    // каждым потоком, одного перехода хватает всем.
    let relearnInFlight = null;
    let relearnHintId = "";
    async function relearnTokenShared() {
      if (relearnInFlight) return relearnInFlight;
      const articleId = relearnHintId;
      const navTabId = sessionTabId;
      if (!articleId || navTabId == null) return;
      relearnInFlight = (async () => {
        const url = `${BASE}${encodeURIComponent(articleId)}`;
        try {
          await new Promise((resolve, reject) => {
            chrome.tabs.update(navTabId, { url }, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve();
            });
          });
          await waitUntilArticlePage(
            navTabId,
            articleId,
            PAGE_LOAD_TIMEOUT_MS,
            () => state.abortRequested,
            () => state.pauseRequested
          );
          await waitForDataMarkers(
            navTabId,
            MARKER_WAIT_MS,
            () => state.abortRequested,
            () => state.pauseRequested
          );
        } catch (e) {}
      })();
      try {
        await relearnInFlight;
      } finally {
        relearnInFlight = null;
      }
    }

    const readerDeps = {
      domScrape: domScrapeViaPool,
      // Токены снимаем и с сессионной вкладки, и с той, где только что грузилась
      // страница: свежие заголовки могут появиться на любой из них.
      captureAndClear: async () => {
        const out = [];
        for (const id of [sessionTabId, lastPageTabId]) {
          if (id == null) continue;
          if (out.length && id === sessionTabId) continue;
          out.push(...(await captureAndClearOnTab(id)));
        }
        return out;
      },
      replay: async (req, headers) => {
        await ensureSessionTabAlive();
        if (requestPacer) await requestPacer.take(1);
        return replayApiOnTab(sessionTabId, req, headers);
      },
      normalize: (rawSnapshot, it) =>
        normalizeArticleSnapshot(rawSnapshot, it?.articleId, it?.shipmentSource || ""),
      relearnToken: relearnTokenShared,
      isOnHubDomain: () => isTabOnArticleOrigin(sessionTabId),
      log: (m) => {
        logApi(m);
        if (!apiLogShown) apiLogShown = true;
      },
    };

    // Reader один на прогон: состояние типов, токены и счётчики общие, а
    // «потоки» просто читают через него параллельно.
    const reader = apiReadReady
      ? globalThis.__gaApiReader.createHubApiReader(readerDeps, {
          opsWarehouses: jobOpsList(),
          verifyEveryN: 25,
          ...apiShared,
        })
      : null;

    // Если API так и не поднялся, весь прогон идёт страницами — тогда пул надо
    // вернуть к числу потоков, иначе двух вкладок на всё не хватит.
    let pagePoolGrown = !apiReadReady;
    async function growPagePoolIfApiDead() {
      if (pagePoolGrown || readStats.api > 0 || readStats.dom < 8) return;
      pagePoolGrown = true;
      const winId = state.workerWindowId;
      if (winId == null) return;
      while (pagePool.size() < threads) {
        try {
          const tab = await new Promise((resolve, reject) => {
            chrome.tabs.create({ windowId: winId, url: "about:blank", active: false }, (t) => {
              if (chrome.runtime.lastError || !t?.id) {
                reject(new Error(chrome.runtime.lastError?.message || "нет вкладки"));
                return;
              }
              resolve(t);
            });
          });
          await forceTabPerformanceMode(tab.id).catch(() => {});
          tabIds.push(tab.id);
          pagePool.add(tab.id);
        } catch {
          break;
        }
      }
      logApi(`Быстрое чтение не поднялось — вкладок под страницы: ${pagePool.size()}.`);
    }

    async function workerLoop(workerIndex) {
      await sleep(Math.min(2000, workerIndex * 140));

      while (!state.abortRequested && (job.phase === "running" || job.phase === "paused")) {
        touchWorkerHeartbeat(mode);
        if (finalizeJobIfComplete(job, totalWorkItems)) {
          await persistJob(job, mode, { force: true });
          break;
        }
        if (state.pauseRequested && job.phase !== "paused") {
          job.phase = "paused";
          job.currentArticleId = null;
          stopWorkerBoost(mode);
          await persistJob(job, mode, { force: true });
        }
        while (state.pauseRequested && !state.abortRequested) {
          touchWorkerHeartbeat(mode);
          await sleep(250);
        }
        if (state.abortRequested) break;
        if (job.phase === "paused") {
          job.phase = "running";
          if (state.workerWindowId != null) {
            startWorkerBoost(mode, state.workerWindowId, tabIds, runConfig.aggressiveMode);
          }
          await persistJob(job, mode, { force: true });
        }
        // Авто-скорость: контроллер может временно «парковать» лишние потоки.
        if (workerIndex >= speedCtl.getThreadLimit()) {
          if (nextAssign >= toFetch.length) break;
          await sleep(450);
          continue;
        }
        const item = takeNext();
        if (!item) break;

        if (!isValidArticleIdForFetch(item.articleId)) {
          job.errors.push({
            articleId: String(item.articleId || "-"),
            message: "Пустой или некорректный ID в исходнике.",
            warehouse: String(item.warehouse || ""),
            operationalWarehouse: String(item.operationalWarehouse || ""),
          });
          job.currentIndex =
            job.results.length + job.errors.length + (job.skippedOpsWarehouse?.length || 0);
          await persistJob(job, mode);
          continue;
        }

        if (getUnsupportedShipmentSkipReason(item)) {
          pushUnsupportedTypeSkip(job, item.articleId);
          await addProcessedIds([item.articleId]);
          job.currentIndex =
            job.results.length + job.errors.length + (job.skippedOpsWarehouse?.length || 0);
          await persistJob(job, mode);
          continue;
        }

        // Вкладку под страницу берёт и готовит сам пул — здесь её больше нет.
        job.currentArticleId = item.articleId;
        await persistJob(job, mode);

        const itemStartedAt = Date.now();
        relearnHintId = item.articleId;
        const perf = { attempts: 0, markersFound: true, cycles: 1 };
        perfByItem.set(item, perf);
        try {
          let data;
          let readPath = "dom";
          if (reader) {
            // Общий таймаут на весь путь чтения: зависший fetch внутри страницы
            // не должен вешать поток — сработает та же логика перезапуска вкладки.
            const rr = await withTimeout(
              reader.read(item),
              ITEM_HARD_TIMEOUT_MS,
              `Таймаут обработки в потоке (${Math.round(ITEM_HARD_TIMEOUT_MS / 1000)}с)`
            );
            data = rr.data;
            readPath = rr.path;
          } else {
            data = await readerDeps.domScrape(item);
          }
          if (readPath === "api") readStats.api += 1;
          else readStats.dom += 1;
          job.readStats = { api: readStats.api, dom: readStats.dom };
          await growPagePoolIfApiDead();
          // Диагностика быстрого чтения: попадает в «Результат», чтобы было
          // видно, почему тот или иной тип читается страницей.
          if (reader) {
            job.apiChannels = reader.snapshot();
            job.apiFallbacks = reader.fallbackSummary();
          } else if (apiUnavailableReason) {
            job.apiChannels = { off: { phase: "off", reason: apiUnavailableReason } };
          }
          speedCtl.reportItem({
            ok: true,
            slow:
              readPath === "dom" &&
              (perf.attempts >= 3 || perf.markersFound === false || perf.cycles > 1),
            durationMs: Date.now() - itemStartedAt,
          });
          const opsList = (Array.isArray(job.opsWarehouses) ? job.opsWarehouses : opsListForJob)
            .map((x) => String(x || "").trim())
            .filter(Boolean);
          const matchedOps = String(data.operationalWarehouse || "").trim();
          const opsSeen = Boolean(data.operationalWarehouseSeen);
          if (data.unsupportedTransitBox) {
            if (!Array.isArray(job.skippedOpsWarehouse)) job.skippedOpsWarehouse = [];
            job.skippedOpsWarehouse.push(`Неподдерживаемый тип: ${item.articleId}`);
            const processed = [item.articleId, data.articleId].filter(Boolean);
            await addProcessedIds(processed);
          } else if (opsList.length > 0 && !matchedOps) {
            if (opsSeen) {
              
              if (!Array.isArray(job.skippedOpsWarehouse)) job.skippedOpsWarehouse = [];
              job.skippedOpsWarehouse.push(`Не наш опер. склад: ${item.articleId}`);
              await addProcessedIds([item.articleId]);
            } else {
              
              job.errors.push({
                articleId: item.articleId,
                message: "Не найден опер. склад на странице",
                warehouse: String(item.warehouse || ""),
                operationalWarehouse: "",
              });
            }
          } else {
            const resultRow = buildJobResultRow(item, data);
            job.results.push(resultRow);
            await saveResultToCache(resultRow);
            const processed = [item.articleId, resultRow.articleId].filter(Boolean);
            await addProcessedIds(processed);
          }
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg === "Остановлено") {
            job.phase = "aborted";
            job.currentArticleId = null;
            state.abortRequested = true;
            await persistJob(job, mode);
            return;
          }
          if (msg.includes("закрыта") || msg.includes("No tab with id")) {
            job.phase = "aborted";
            job.currentArticleId = null;
            state.abortRequested = true;
            job.errors.push({
              articleId: item.articleId,
              message: "Окна парсинга закрыты пользователем.",
              warehouse: String(item.warehouse || ""),
              operationalWarehouse: String(item.operationalWarehouse || ""),
            });
            await persistJob(job, mode);
            return;
          }
          // Зависшую вкладку подменяет сам пул — здесь только учёт скорости.
          speedCtl.reportItem({
            ok: false,
            hardFail: msg.includes("Таймаут"),
            durationMs: Date.now() - itemStartedAt,
          });
          job.errors.push({
            articleId: item.articleId,
            message: msg,
            warehouse: String(item.warehouse || ""),
            operationalWarehouse: String(item.operationalWarehouse || ""),
          });
        }

        job.speed = speedCtl.snapshot();
        job.currentIndex =
          job.results.length + job.errors.length + (job.skippedOpsWarehouse?.length || 0);
        await persistJob(job, mode);

        const postDelayMs = speedCtl.getDelayMs();
        if (postDelayMs > 0) {
          while (state.pauseRequested && !state.abortRequested) {
            await sleep(250);
          }
          await sleep(postDelayMs);
        }
      }
    }

    await Promise.all(Array.from({ length: threads }, (_, idx) => workerLoop(idx)));

    const queueExhausted = nextAssign >= toFetch.length;
    if (state.abortRequested || job.phase === "aborted") {
      job.phase = "aborted";
      job.currentArticleId = null;
    } else if (finalizeJobIfComplete(job, totalWorkItems)) {
    } else if (queueExhausted) {
      
      
      await flushProcessedIds(true).catch(() => {});
      const rebuilt = await rebuildToFetchFromSourceForJob(mode, job).catch(() => null);
      if (Array.isArray(rebuilt) && rebuilt.length === 0) {
        job.phase = "done";
        job.currentArticleId = null;
        job.currentIndex = countJobProcessed(job);
        job.plannedTotal = countJobProcessed(job);
      } else {
        job.phase = "paused";
        job.currentArticleId = null;
        job.stopReason =
          job.stopReason ||
          "Обработка прервана (фоновый процесс). Нажмите «Продолжить» или откройте расширение.";
      }
    } else if (job.phase === "running" || job.phase === "paused") {
      job.phase = "paused";
      job.currentArticleId = null;
      job.stopReason =
        job.stopReason ||
        "Обработка прервана (фоновый процесс). Нажмите «Продолжить» или откройте расширение.";
    }
  } finally {
    const trulyDone = job.phase === "done" && isJobWorkComplete(job);
    const incompleteResumable =
      !state.abortRequested &&
      job.phase !== "aborted" &&
      !trulyDone &&
      (job.phase === "paused" || job.phase === "running" || !isJobWorkComplete(job));
    if (job.phase === "done" && !isJobWorkComplete(job)) {
      job.phase = "paused";
      job.stopReason =
        job.stopReason ||
        "Обработка прервана (фоновый процесс). Нажмите «Продолжить» или откройте расширение.";
    }
    state.activeRunConfig = null;
    state.liveJob = null;
    await closeWorkerResources(mode);
    job.currentArticleId = null;
    job.abortRequested = state.abortRequested;
    delete job.workerWindowId;
    delete job.workerTabIds;
    if (incompleteResumable && job.phase !== "aborted") {
      job.phase = "paused";
    }
    await persistJob(job, mode, { force: true });
    await flushResultsCache(true);
    await flushProcessedIds(true);
    if (incompleteResumable) {
      await ensureKeepAliveAlarm();
      const now = Date.now();
      if (now - (lastAutoResumeAt[mode] || 0) >= 4000) {
        lastAutoResumeAt[mode] = now;
        void tryResumePausedJob(mode).catch(() => {});
      }
    } else {
      await clearKeepAliveAlarmIfIdle();
    }
    if (job.phase === "aborted") {
      await emitActiveTabsToast("Остановлено. «Результат» в расширении.");
    } else if (job.phase === "done" && isJobWorkComplete(job)) {
      const resN = Array.isArray(job.results) ? job.results.length : Number(job.resultsCount) || 0;
      const errN = Array.isArray(job.errors) ? job.errors.length : Number(job.errorsCount) || 0;
      if (resN === 0 && errN === 0) {
        await emitActiveTabsToast("Нечего обрабатывать.");
      } else {
        await emitActiveTabsToast(await buildDoneToastMessage(job));
      }
    }
  }
}

// --- DEV-диагностика ---------------------------------------------------------
// Собирает по выборке объектов всё, что нужно для разбора: сырые ответы API,
// прочитанную страницу, из чего страница собрана, расхождения поле в поле и
// разбивку времени по этапам. Токены сюда не попадают — только имена
// заголовков, которые до API доехали.
const DEV_DIAG_KEY = "goodsAuditDevDiagV1";
const DEV_DIAG_MAX_ITEMS = 60;
let devDiagRunning = false;
let devDiagAbort = false;

async function readDevDiagState() {
  try {
    const { [DEV_DIAG_KEY]: st } = await chrome.storage.local.get(DEV_DIAG_KEY);
    return st && typeof st === "object" ? st : null;
  } catch {
    return null;
  }
}

async function writeDevDiagState(patch) {
  const prev = (await readDevDiagState()) || {};
  const next = Object.assign({}, prev, patch);
  try {
    await chrome.storage.local.set({ [DEV_DIAG_KEY]: next });
  } catch {}
  return next;
}

// Берём объекты «вразбивку» по всему списку, а не первые подряд: так в выборку
// попадают разные типы отправлений, а не один хвост файла.
function sampleArticleIds(ids, limit) {
  const uniq = [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))];
  const n = Math.max(1, Math.min(DEV_DIAG_MAX_ITEMS, Math.floor(Number(limit) || 0) || 20));
  if (uniq.length <= n) return uniq;
  const step = uniq.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(uniq[Math.floor(i * step)]);
  return [...new Set(out)];
}

function diffSnapshots(apiData, domData) {
  const fields = globalThis.__gaApiMapping?.SCRAPE_FIELDS || [];
  const out = [];
  for (const f of fields) {
    const a = apiData?.[f];
    const d = domData?.[f];
    const same = f === "price" ? Number(a) === Number(d) : String(a ?? "") === String(d ?? "");
    if (!same) out.push({ field: f, api: a ?? null, dom: d ?? null });
  }
  return out;
}

async function devApiCall(tabId, req, headers, log) {
  if (!req) return null;
  const t0 = Date.now();
  let res;
  try {
    res = await replayApiOnTab(tabId, req, headers);
  } catch (e) {
    res = { status: 0, body: null, error: String((e && e.message) || e) };
  }
  const entry = {
    url: req.url,
    method: req.method || "GET",
    status: Number(res?.status) || 0,
    ms: Date.now() - t0,
    body: res?.body ?? null,
  };
  if (res?.error) entry.error = String(res.error);
  log.push(entry);
  return entry;
}

async function runDevDiagnostics(msg) {
  const RT = globalThis.__gaApiReturns;
  const M = globalThis.__gaApiMapping;
  const opsWarehouses = Array.isArray(msg.opsWarehouses)
    ? msg.opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  let sourceText = String(msg.sourceText || "").trim();
  if (msg.sourceFromCache && globalThis.__goodsAuditCache) {
    try {
      const entry = await globalThis.__goodsAuditCache.loadSourceCache(
        normalizeSourceMode(msg.sourceMode)
      );
      if (entry?.text) sourceText = String(entry.text).trim();
    } catch {}
  }
  if (!sourceText) throw new Error("Нет исходника: вставьте ID или выберите файл.");

  const parsed = globalThis.__returnsParseSourceRows(sourceText, false);
  const ids = sampleArticleIds((parsed.rows || []).map((r) => r.articleId), msg.limit);
  if (!ids.length) throw new Error("В исходнике не нашлось ни одного ID.");

  const started = Date.now();
  const report = {
    kind: "goodsaudit-dev-diagnostics",
    version: 1,
    extensionVersion: chrome.runtime.getManifest?.()?.version || "",
    startedAt: new Date(started).toISOString(),
    opsWarehouses,
    sampleSize: ids.length,
    // Значения заголовков не сохраняем принципиально — только имена.
    authHeaderNames: [],
    items: [],
    totals: {},
  };

  // Своё окно, а не общее рабочее: диагностика не должна трогать состояние
  // прогона и его вкладки.
  const { windowId, tabId } = await openDevWindow();
  let authHeaders = {};

  try {
    for (let i = 0; i < ids.length; i++) {
      if (devDiagAbort) break;
      const articleId = ids[i];
      await writeDevDiagState({
        phase: "running",
        done: i,
        total: ids.length,
        currentArticleId: articleId,
      });

      const rec = { articleId, api: { requests: [] }, dom: {}, diff: null };
      const item = { articleId, shipmentSource: "" };

      // 1) Страница. Она же обновляет токены в перехватчике.
      const perf = { attempts: 0, markersFound: true, cycles: 1 };
      const tDom = Date.now();
      let domRaw = null;
      try {
        domRaw = await scrapeArticleOnTab(
          tabId,
          articleId,
          () => 900,
          opsWarehouses,
          "",
          () => devDiagAbort,
          () => false,
          perf
        );
      } catch (e) {
        rec.dom.error = String((e && e.message) || e);
      }
      rec.dom.ms = Date.now() - tDom;
      rec.dom.perf = perf;
      rec.dom.raw = domRaw;
      rec.dom.data = domRaw ? normalizeArticleSnapshot(domRaw, articleId, "") : null;

      // 2) Из чего страница собрана — таблицы, свойства, бейджи.
      try {
        await execScriptFiles(tabId, ["page-scrape.js"]);
        const probe = await execScriptFunc(
          tabId,
          (ops) => {
            try {
              const fn = globalThis.__returnsDevProbe;
              return typeof fn === "function" ? fn(ops || []) : { __error: "нет __returnsDevProbe" };
            } catch (e) {
              return { __error: String((e && e.message) || e) };
            }
          },
          [opsWarehouses]
        );
        rec.dom.probe = probe?.[0]?.result ?? null;
      } catch (e) {
        rec.dom.probeError = String((e && e.message) || e);
      }

      // 3) Токены — из живой страницы, в отчёт идут только имена заголовков.
      try {
        const fresh = M.latestAuthHeaders(await captureAndClearOnTab(tabId));
        if (Object.keys(fresh).length) authHeaders = fresh;
      } catch {}
      rec.api.authHeaderNames = Object.keys(authHeaders);
      for (const name of rec.api.authHeaderNames) {
        if (!report.authHeaderNames.includes(name)) report.authHeaderNames.push(name);
      }

      // 4) API теми же ручками и в том же порядке, что и в рабочем чтении.
      const tApi = Date.now();
      const typeRes = await devApiCall(
        tabId,
        RT.resolveTypeRequest(articleId),
        authHeaders,
        rec.api.requests
      );
      const articleType = String(typeRes?.body?.articleType || "").trim();
      const apiId = String(typeRes?.body?.articleId ?? "").trim() || articleId;
      rec.api.articleType = articleType;
      rec.api.articleId = apiId;
      rec.api.supported = RT.isSupportedType(articleType);

      let info = null;
      let content = null;
      if (rec.api.supported) {
        const [infoRes, contentRes] = await Promise.all([
          devApiCall(tabId, RT.infoRequest(articleType, apiId), authHeaders, rec.api.requests),
          devApiCall(tabId, RT.contentRequest(articleType, apiId), authHeaders, rec.api.requests),
        ]);
        info = infoRes?.body ?? null;
        content = contentRes?.body ?? null;
      }
      // Перевозку спрашиваем по тому же условию, что и рабочее чтение: только
      // когда текущее место не наше. Иначе отчёт завышал бы число запросов на
      // объект — а это и есть предел скорости.
      const preSnapshot = rec.api.supported
        ? RT.mapByType(articleType, info, content)
        : RT.mapUnsupported(apiId);
      const preOps = M.resolveOpsWarehouse(preSnapshot?.operationalWarehouse, opsWarehouses);
      if (rec.api.supported && opsWarehouses.length && !preOps.matched) {
        await devApiCall(
          tabId,
          RT.lastCarriageRequest(articleType, apiId),
          authHeaders,
          rec.api.requests
        );
      }
      rec.api.ms = Date.now() - tApi;

      // 5) Наш маппинг: что мы из этого собираем и что мешает включиться.
      rec.api.unknownCodes = rec.api.supported ? RT.unknownCodesInInfo(articleType, info) : [];
      const snapshot = preSnapshot;
      rec.api.snapshot = snapshot;
      if (snapshot) {
        // Склад считаем ровно как рабочее чтение: не нашли наш в текущем месте —
        // берём его из последней перевозки. Иначе отчёт показывал бы
        // расхождения, которых в прогоне нет.
        let ops = preOps;
        if (!ops.matched && opsWarehouses.length && rec.api.supported) {
          const carriage = (rec.api.requests || []).find((q) => /last-carriage/.test(q.url));
          for (const place of RT.carriagePlaceNames(carriage?.body)) {
            const hit = M.resolveOpsWarehouse(place, opsWarehouses);
            if (hit.matched) {
              ops = { matched: hit.matched, seen: true };
              break;
            }
          }
        }
        const shaped = Object.assign({}, snapshot, {
          operationalWarehouse: ops.matched,
          operationalWarehouseSeen: ops.seen,
        });
        rec.api.data = normalizeArticleSnapshot(shaped, articleId, "");
        rec.diff = diffSnapshots(rec.api.data, rec.dom.data);
      }

      report.items.push(rec);
    }
  } finally {
    await safeRemoveWindow(windowId).catch(() => {});
  }

  const domTimes = report.items.map((r) => Number(r.dom?.ms) || 0);
  const apiTimes = report.items.map((r) => Number(r.api?.ms) || 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? Math.round(sum(a) / a.length) : 0);
  const phase = (k) => avg(report.items.map((r) => Number(r.dom?.perf?.[k]) || 0));
  report.totals = {
    items: report.items.length,
    msTotal: Date.now() - started,
    domAvgMs: avg(domTimes),
    apiAvgMs: avg(apiTimes),
    domPhaseAvgMs: {
      navigate: phase("msNavigate"),
      settle: phase("msSettle"),
      markers: phase("msMarkers"),
      inject: phase("msInject"),
      read: phase("msRead"),
    },
    itemsWithDiff: report.items.filter((r) => (r.diff || []).length).length,
    byArticleType: report.items.reduce((acc, r) => {
      const k = r.api?.articleType || "неизвестен";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

async function openDevWindow() {
  const win = await new Promise((resolve, reject) => {
    chrome.windows.create(
      { url: "about:blank", focused: false, type: "normal", width: 440, height: 320, left: 48, top: 48 },
      (w) => {
        if (chrome.runtime.lastError || !w?.id) {
          reject(new Error(chrome.runtime.lastError?.message || "Не удалось открыть окно диагностики"));
          return;
        }
        resolve(w);
      }
    );
  });
  await sleep(120);
  const tabs = await new Promise((resolve) => chrome.tabs.query({ windowId: win.id }, resolve));
  const tabId = tabs?.[0]?.id;
  if (tabId == null) {
    await safeRemoveWindow(win.id).catch(() => {});
    throw new Error("Во вкладке диагностики нет вкладки");
  }
  await forceTabPerformanceMode(tabId).catch(() => {});
  return { windowId: win.id, tabId };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  if (msg?.type === "SW_KEEPALIVE") {
    for (const mode of ["file", "text"]) {
      const state = getRunState(mode);
      if (state.running) touchWorkerHeartbeat(mode);
    }
    
    void reconcileActiveJobsAfterWake().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "DEV_DIAG_START") {
    if (devDiagRunning) {
      sendResponse({ ok: false, error: "Диагностика уже идёт." });
      return false;
    }
    if (runStates.file.running || runStates.text.running) {
      sendResponse({ ok: false, error: "Сначала остановите прогон." });
      return false;
    }
    devDiagRunning = true;
    devDiagAbort = false;
    sendResponse({ ok: true });
    void (async () => {
      await writeDevDiagState({
        phase: "running",
        done: 0,
        total: 0,
        currentArticleId: null,
        error: "",
        report: null,
      });
      try {
        const report = await runDevDiagnostics(msg || {});
        await writeDevDiagState({
          phase: devDiagAbort ? "aborted" : "done",
          done: report.items.length,
          total: report.items.length,
          currentArticleId: null,
          report,
        });
      } catch (e) {
        await writeDevDiagState({
          phase: "error",
          currentArticleId: null,
          error: String((e && e.message) || e),
          report: null,
        });
      } finally {
        devDiagRunning = false;
        devDiagAbort = false;
      }
    })();
    return false;
  }

  if (msg?.type === "DEV_DIAG_STATE") {
    void readDevDiagState().then((st) => sendResponse({ ok: true, state: st }));
    return true;
  }

  if (msg?.type === "DEV_DIAG_ABORT") {
    devDiagAbort = true;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "DEV_DIAG_CLEAR") {
    void chrome.storage.local.remove(DEV_DIAG_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === "ABORT_BATCH") {
    const mode = normalizeSourceMode(msg.sourceMode);
    const state = getRunState(mode);
    state.abortRequested = true;
    state.pauseRequested = false;
    if (state.liveJob && (state.liveJob.phase === "running" || state.liveJob.phase === "paused")) {
      state.liveJob.phase = "aborted";
      state.liveJob.currentArticleId = null;
      state.liveJob.abortRequested = true;
      state.liveJob.stopReason = "Остановлено пользователем.";
    }
    closeWorkerResources(mode)
      .catch(() => {})
      .finally(() => markJobAborted(mode, "Остановлено пользователем.", { asError: false }))
      .finally(() => {
        state.running = false;
        void clearKeepAliveAlarmIfIdle();
        sendResponse({ ok: true });
      });
    return true;
  }

  if (msg?.type === "RELEASE_JOB_CLEAR") {
    const mode = normalizeSourceMode(msg.sourceMode);
    jobClearedModes[mode] = false;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "CLEAR_JOB") {
    (async () => {
      const mode = normalizeSourceMode(msg.sourceMode);
      const state = getRunState(mode);
      const jobKey = getJobKeyByMode(mode);
      const q = persistQueues[mode];
      
      if (state.running || state.liveJob?.phase === "running" || state.liveJob?.phase === "paused") {
        sendResponse({ ok: false, error: "job_active" });
        return;
      }
      
      jobClearedModes[mode] = true;
      state.liveJob = null;
      state.activeRunConfig = null;
      state.running = false;
      state.abortRequested = false;
      state.pauseRequested = false;
      if (q) {
        q.pending = null;
        q.itemCounter = 0;
        if (q.timer) {
          clearTimeout(q.timer);
          q.timer = null;
        }
      }
      try {
        await chrome.storage.local.remove(jobKey);
        
        await sleep(0);
        await chrome.storage.local.remove(jobKey);
      } catch {
      }
      await clearKeepAliveAlarmIfIdle().catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "GET_JOB") {
    (async () => {
      const mode = normalizeSourceMode(msg.sourceMode);
      const state = getRunState(mode);
      const jobKey = getJobKeyByMode(mode);
      if (jobClearedModes[mode]) {
        sendResponse({ ok: true, job: null });
        return;
      }
      
      if (state.liveJob) {
        if (isJobWorkComplete(state.liveJob)) {
          finalizeJobIfComplete(state.liveJob);
          await persistJob(state.liveJob, mode, { force: true });
        }
        sendResponse({ ok: true, job: state.liveJob });
        return;
      }
      await recoverIfOrphanedRun(mode);
      void reconcileActiveJobsAfterWake().catch(() => {});
      if (jobClearedModes[mode]) {
        sendResponse({ ok: true, job: null });
        return;
      }
      const obj = await chrome.storage.local.get(jobKey);
      let job = obj[jobKey];
      if (job && isJobWorkComplete(job)) {
        finalizeJobIfComplete(job);
        await writeJobToStorage(job, mode);
        sendResponse({ ok: true, job });
        return;
      }
      
      if (
        !state.running &&
        job &&
        !isJobWorkComplete(job) &&
        (job.phase === "running" || (job.phase === "paused" && !job.userPaused))
      ) {
        void tryResumePausedJob(mode).catch(() => {});
      }
      if (state.liveJob) {
        sendResponse({ ok: true, job: state.liveJob });
        return;
      }
      sendResponse({ ok: true, job: job || null });
    })();
    return true;
  }

  if (msg?.type === "PAUSE_BATCH") {
    (async () => {
      const mode = normalizeSourceMode(msg.sourceMode);
      const state = getRunState(mode);
      const jobKey = getJobKeyByMode(mode);
      state.pauseRequested = true;
      stopWorkerBoost(mode);
      await hydrateWorkerWindowId(mode);
      if (state.liveJob && state.liveJob.phase === "running") {
        state.liveJob.phase = "paused";
        state.liveJob.currentArticleId = null;
        state.liveJob.userPaused = true;
        delete state.liveJob.stopReason;
      }
      const obj = await chrome.storage.local.get(jobKey);
      const job = obj[jobKey];
      if (job && job.phase === "running") {
        job.phase = "paused";
        job.currentArticleId = null;
        job.userPaused = true;
        delete job.stopReason;
        job.updatedAt = Date.now();
        if (state.workerWindowId != null) job.workerWindowId = state.workerWindowId;
        await chrome.storage.local.set({ [jobKey]: job });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "RESUME_BATCH") {
    (async () => {
      const mode = normalizeSourceMode(msg.sourceMode);
      const state = getRunState(mode);
      const jobKey = getJobKeyByMode(mode);
      jobClearedModes[mode] = false;
      state.pauseRequested = false;
      await hydrateWorkerWindowId(mode);
      const resumeOps = Array.isArray(msg.opsWarehouses)
        ? msg.opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean)
        : null;
      if (state.liveJob && state.liveJob.phase === "paused") {
        state.liveJob.phase = "running";
        delete state.liveJob.userPaused;
        delete state.liveJob.stopReason;
        if (resumeOps) state.liveJob.opsWarehouses = resumeOps;
      }
      const obj = await chrome.storage.local.get(jobKey);
      const job = obj[jobKey];
      if (job && job.phase === "paused") {
        job.phase = "running";
        delete job.userPaused;
        delete job.stopReason;
        if (resumeOps) job.opsWarehouses = resumeOps;
        job.updatedAt = Date.now();
        if (state.workerWindowId != null) job.workerWindowId = state.workerWindowId;
        await chrome.storage.local.set({ [jobKey]: job });
      }
      if (!state.running) {
        await tryResumePausedJob(mode);
      } else if (state.workerWindowId != null) {
        const tabs = await queryTabsInWindow(state.workerWindowId);
        const tabIds = tabs
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((t) => t.id)
          .filter((id) => id != null);
        const focus = state.activeRunConfig?.aggressiveMode === true;
        if (tabIds.length > 0) startWorkerBoost(mode, state.workerWindowId, tabIds, focus);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "UPDATE_AGGRESSIVE_MODE") {
    (async () => {
      const mode = normalizeSourceMode(msg.sourceMode);
      const state = getRunState(mode);
      const jobKey = getJobKeyByMode(mode);
      const nextAggressiveMode = msg.aggressiveMode === true;

      // Stop focus-stealing boost immediately so the extension popup is not closed.
      stopWorkerBoost(mode);

      if (state.activeRunConfig) {
        state.activeRunConfig.aggressiveMode = nextAggressiveMode;
      }

      const wid = await hydrateWorkerWindowId(mode);
      let tabIds = [];
      if (wid != null) {
        const tabs = await queryTabsInWindow(wid);
        tabIds = tabs
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((t) => t.id)
          .filter((id) => id != null);
        await Promise.all(
          tabIds.map((id) => updateTab(id, { autoDiscardable: false }).catch(() => {}))
        );
        // Only bring to front when enabling. Never touch window focus/state when disabling.
        if (nextAggressiveMode) {
          await forceWindowPerformanceMode(wid, true).catch(() => {});
        }
        if (tabIds.length > 0 && state.running && !state.pauseRequested) {
          startWorkerBoost(mode, wid, tabIds, nextAggressiveMode);
        }
      }

      const obj = await chrome.storage.local.get(jobKey);
      const job = obj[jobKey];
      if (job && (job.phase === "running" || job.phase === "paused")) {
        job.aggressiveMode = nextAggressiveMode;
        job.updatedAt = Date.now();
        if (wid != null) job.workerWindowId = wid;
        await chrome.storage.local.set({ [jobKey]: job });
      }
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type !== "START_BATCH") return false;

  sendResponse({ ok: true });

  (async () => {
    const sourceMode = normalizeSourceMode(msg.sourceMode);
    const state = getRunState(sourceMode);
    
    jobClearedModes[sourceMode] = false;
    await recoverIfOrphanedRun(sourceMode);
    if (state.running) return;

    try {
      const jobKey = getJobKeyByMode(sourceMode);
      const { [jobKey]: existing } = await chrome.storage.local.get(jobKey);
      if (
        existing &&
        (existing.phase === "paused" || existing.phase === "running") &&
        !isJobWorkComplete(existing)
      ) {
        await tryResumePausedJob(sourceMode);
        return;
      }
    } catch {
    }

    let sourceText = String(msg.sourceText || "").trim();
    if (msg.sourceFromCache && globalThis.__goodsAuditCache) {
      try {
        const entry = await globalThis.__goodsAuditCache.loadSourceCache(sourceMode);
        if (entry?.text) sourceText = String(entry.text).trim();
      } catch {
      }
    }
    const sourceName = String(msg.sourceName || "").trim();
    const aggressiveMode =
      typeof msg.aggressiveMode === "boolean"
        ? msg.aggressiveMode
        : await getAggressiveModeEnabled();
    const opsWarehouses = Array.isArray(msg.opsWarehouses)
      ? msg.opsWarehouses.map((x) => String(x || "").trim()).filter(Boolean)
      : [];

    if (!sourceText) return;

    state.running = true;
    state.abortRequested = false;
    state.pauseRequested = false;
    await ensureKeepAliveAlarm();

    try {
      const parsed = globalThis.__returnsParseSourceRows(sourceText, false);
      const parsedRows = parsed.rows;
      const processed = await getProcessedSet();
      const byArticle = new Map();
      const skippedDupSource = [];
      for (const row of parsedRows) {
        const { warehouse, articleId, operationalWarehouse } = row;
        if (byArticle.has(articleId)) {
          skippedDupSource.push(`Дубликат в исходнике: ${articleId}`);
          continue;
        }
        byArticle.set(articleId, row);
      }

      const skippedMem = [];
      const skippedMemIds = [];
      const skippedOpsWarehouse = [];
      const skippedTypeIds = [];
      const toFetch = [];
      for (const row of byArticle.values()) {
        const { warehouse, articleId, operationalWarehouse, shipmentSource, postingType } = row;
        if (processed.has(String(articleId || "").trim())) {
          skippedMem.push(`Уже в памяти: ${articleId}`);
          skippedMemIds.push(articleId);
          continue;
        }
        const item = {
          warehouse,
          articleId,
          operationalWarehouse,
          shipmentSource: String(shipmentSource || ""),
          postingType: String(postingType || ""),
        };
        if (getUnsupportedShipmentSkipReason(item)) {
          skippedOpsWarehouse.push(`Неподдерживаемый тип: ${articleId}`);
          skippedTypeIds.push(articleId);
          continue;
        }
        toFetch.push(item);
      }
      if (skippedTypeIds.length) {
        await addProcessedIds(skippedTypeIds);
        await flushProcessedIds(true).catch(() => {});
      }

      const cachedResults = (await loadCachedResultsForIds(skippedMemIds)).map((row) => ({
        ...row,
        fromMemory: true,
      }));

      const sourceVisibleCount = Math.max(0, Number(msg.sourceVisibleCount) || 0);
      const plannedTotal = cachedResults.length + toFetch.length + skippedOpsWarehouse.length;
      const inputStats = {
        sourceVisibleCount,
        totalNonEmptyLines: parsed.totalNonEmptyLines,
        headerRows: parsed.headerSkipped ? 1 : 0,
        missingIdRows: parsed.missingIdRows,
        duplicateRows: skippedDupSource.length,
        skippedMemRows: skippedMem.length,
        skippedTypeRows: skippedOpsWarehouse.length,
        uniqueRows: byArticle.size,
        toFetchRows: plannedTotal,
        remainingRows: toFetch.length,
      };

      await runJobFromState({
        sourceMode,
        sourceName,
        manualThreads: parseManualThreads(msg.threads),
        aggressiveMode,
        opsWarehouses,
        toFetch,
        skippedMem,
        skippedDupSource,
        skippedOpsWarehouse,
        inputStats,
        initialResults: cachedResults,
        initialToFetchTotal: plannedTotal,
      });
    } catch (e) {
      await closeWorkerResources(sourceMode);
      const errJob = {
        phase: "done",
        sourceMode,
        sourceName,
        autoSpeed: true,
        aggressiveMode,
        threads: 0,
        toFetch: [],
        skippedMem: [],
        skippedDupSource: [],
        currentIndex: 0,
        currentArticleId: null,
        results: [],
        errors: [{ articleId: "-", message: String(e?.message || e) }],
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ [getJobKeyByMode(sourceMode)]: errJob });
      await emitActiveTabsToast(`Ошибка запуска: ${String(e?.message || e)}`);
    } finally {
      state.running = false;
    }
  })();

  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const closedId = Number(windowId);
    for (const mode of ["file", "text"]) {
      const state = getRunState(mode);
      if (state.closingWindowIds.has(closedId)) continue;
      let matched = state.workerWindowId != null && closedId === Number(state.workerWindowId);
      if (!matched) {
        try {
          const jobKey = getJobKeyByMode(mode);
          const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
          matched =
            job?.workerWindowId != null &&
            closedId === Number(job.workerWindowId) &&
            (job.phase === "running" || job.phase === "paused");
        } catch {
          matched = false;
        }
      }
      if (!matched) continue;

      if (state.running || state.liveJob?.phase === "running") {
        await abortActiveRunAsStopped(mode, "Окна парсинга закрыты пользователем.").catch(() => {});
      } else {
        state.workerWindowId = null;
        await clearPersistedWorkerWindowMeta(mode).catch(() => {});
      }
      break;
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== KEEP_ALIVE_ALARM) return;
  void (async () => {
    for (const mode of ["file", "text"]) {
      const state = getRunState(mode);
      if (state.running) {
        touchWorkerHeartbeat(mode);
        const wid = state.workerWindowId;
        if (wid != null && !state.pauseRequested) {
          const tabs = await queryTabsInWindow(wid).catch(() => []);
          for (const tab of tabs) {
            if (tab?.id != null) await ensureTabNotDiscarded(tab.id).catch(() => {});
          }
        }
      }
    }
    await reconcileActiveJobsAfterWake().catch(() => {});
  })();
});

void reconcileActiveJobsAfterWake().catch(() => {});

chrome.runtime.onStartup.addListener(() => {
  void reconcileActiveJobsAfterWake().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcileActiveJobsAfterWake().catch(() => {});
});
