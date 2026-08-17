const JOB_KEY_FILE = "returnsExcelJobFileV1";
const JOB_KEY_TEXT = "returnsExcelJobTextV1";
const JOB_UNDO_KEY_FILE = "returnsExcelJobUndoFileV1";
const JOB_UNDO_KEY_TEXT = "returnsExcelJobUndoTextV1";
const PROCESSED_KEY = "processedArticleIds";
const RESULTS_CACHE_KEY = "processedResultsCacheV1";
const POPUP_PREFS_KEY = "returnsPopupPrefsV1";
const CAPTCHA_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CACHE_CLEAR_HASH = "dfd3a946b87ee8c473eb8518bd8c7fc9b8d808bd07a894fde7dee3720888b9ee";
const CUP_POSTINGS_URL = "https://cerberus-front.prod.a.o3.ru/postings-data?subTab=postings";

const $ = (id) => document.getElementById(id);

let xlsxLoadPromise = null;
function ensureXlsxLoaded() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  if (xlsxLoadPromise) return xlsxLoadPromise;
  xlsxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "xlsx.full.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Не удалось загрузить парсер Excel"));
    document.documentElement.appendChild(s);
  });
  return xlsxLoadPromise;
}

let appToastTimer = null;

function showAppToast(message, durationMs = 4200, opts = {}) {
  const el = $("appToast");
  if (!el) return;
  el.replaceChildren();
  if (opts.htmlNode instanceof Node) {
    el.appendChild(opts.htmlNode);
    el.style.pointerEvents = "auto";
  } else {
    el.textContent = String(message || "");
    el.style.pointerEvents = "none";
  }
  el.hidden = false;
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    el.hidden = true;
    el.replaceChildren();
    appToastTimer = null;
  }, Math.max(1200, Number(durationMs) || 4200));
}

function askAppConfirm(message, title = "Подтверждение") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "captcha-modal-overlay";
    const card = document.createElement("div");
    card.className = "captcha-modal-card";
    const t = document.createElement("div");
    t.className = "captcha-modal-title";
    t.textContent = title;
    const p = document.createElement("p");
    p.className = "captcha-modal-warn";
    p.textContent = String(message || "");
    const actions = document.createElement("div");
    actions.className = "actions captcha-modal-actions";
    const btnNo = document.createElement("button");
    btnNo.type = "button";
    btnNo.className = "btn btn-secondary btn-sm";
    btnNo.textContent = "Отмена";
    const btnYes = document.createElement("button");
    btnYes.type = "button";
    btnYes.className = "btn btn-primary btn-sm";
    btnYes.textContent = "ОК";
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(Boolean(v));
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
    };
    btnNo.addEventListener("click", () => done(false));
    btnYes.addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    actions.append(btnNo, btnYes);
    card.append(t, p, actions);
    overlay.append(card);
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    btnYes.focus();
  });
}

function askAppInput({
  title = "Введите значение",
  message = "",
  value = "",
  placeholder = "",
  okText = "ОК",
  cancelText = "Отмена",
  inputType = "text",
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "captcha-modal-overlay";
    const card = document.createElement("div");
    card.className = "captcha-modal-card";

    const t = document.createElement("div");
    t.className = "captcha-modal-title";
    t.textContent = String(title || "");

    const p = document.createElement("p");
    p.className = "captcha-modal-warn captcha-modal-warn--primary";
    p.textContent = String(message || "");

    const input = document.createElement("input");
    input.type = inputType === "password" ? "password" : "text";
    input.className = "captcha-modal-input captcha-modal-input--text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = String(placeholder || "");
    input.value = String(value || "");

    const actions = document.createElement("div");
    actions.className = "actions captcha-modal-actions";

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = "btn btn-primary btn-sm";
    btnOk.textContent = String(okText || "ОК");

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "btn btn-secondary btn-sm";
    btnCancel.textContent = String(cancelText || "Отмена");

    const done = (v, closeAsCancel = false) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(closeAsCancel ? null : String(v ?? ""));
    };

    const submit = () => done(input.value, false);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done("", true);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };

    btnOk.addEventListener("click", submit);
    btnCancel.addEventListener("click", () => done("", true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done("", true);
    });

    actions.append(btnOk, btnCancel);
    card.append(t, p, input, actions);
    overlay.append(card);
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    input.focus();
    input.setSelectionRange(0, input.value.length);
  });
}

const copyButtonLabels = {
  ge10k: "",
  lt10k: "",
  vulnerable: "Товары группы уязвимости",
  allRows: "Копировать всё",
  errors: "Копировать ошибки",
};
const OUTPUT_FIELDS = [
  { id: "empty", label: "(пусто)" },
  { id: "requestDate", label: "Дата запроса" },
  { id: "operationalWarehouse", label: "Опер. склад" },
  { id: "articleId", label: "ID отправления" },
  { id: "shipment", label: "Отправление" },
  { id: "nomenclature", label: "Номенклатура" },
  { id: "price", label: "Цена" },
  { id: "activeStatus", label: "Активный статус" },
  { id: "statusLozon", label: "Статус lozon" },
  { id: "statusAlps", label: "Статус ALPS" },
  { id: "deliveryScheme", label: "Схема доставки" },
  { id: "formationWarehouse", label: "Склад формирования" },
  { id: "owner", label: "Собственник" },
  { id: "vulnerabilityTriggerKeyword", label: "Кейворд триггер" },
];
const DEFAULT_PRICE_THRESHOLD = 10000;
const DEFAULT_MIN_PRICE_THRESHOLD = 0;
const DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD = 0;
const DEFAULT_LAYOUT_GE = [
  "statusLozon",
  "operationalWarehouse",
  "statusAlps",
  "empty",
  "empty",
  "nomenclature",
  "requestDate",
  "empty",
  "shipment",
  "price",
];
const DEFAULT_LAYOUT_LT = [
  "requestDate",
  "statusLozon",
  "operationalWarehouse",
  "statusAlps",
  "shipment",
  "empty",
  "price",
  "nomenclature",
  "empty",
  "empty",
];
const DEFAULT_VULNERABILITY_KEYWORDS = [
  "Графический планшет-монитор",
  "Зажим для галстука",
  "Глидерный браслет",
  "Электронная книга",
  "Портативный проектор",
  "Графический планшет",
  "Игровая консоль",
  "Браслет-обруч",
  "Слейв-браслет",
  "Фитнес-трекер",
  "Видеодомофон",
  "Пусеты",
  "Робот-пылесос",
  "Умная розетка",
  "Смарт-зеркало",
  "Смарт-кольцо",
  "Смарт-замок",
  "Fairphone",
  "Blackview",
  "PlayStation",
  "Смарт-часы",
  "Умные часы",
  "Ультрабук",
  "Motorola",
  "OnePlus",
  "Panasonic",
  "Unihertz",
  "Micromax",
  "Coolpad",
  "Шандельер",
  "Смартфон",
  "Видеокарта",
  "Смарт-ТВ",
  "Джекеты",
  "Протяжки",
  "Медальон",
  "Перстень",
  "Букридер",
  "Ожерелье",
  "Nintendo",
  "Печатка",
  "Планшет",
  "Realme",
  "Samsung",
  "Infinix",
  "Nothing",
  "Телевизор",
  "Цепочка",
  "Гвоздики",
  "Наушники",
  "Подвеска",
  "GeForce",
  "Gigabyte",
  "Honor",
  "Huawei",
  "iPhone",
  "Itel",
  "Kindle",
  "Kyocera",
  "Lenovo",
  "MacBook",
  "Meizu",
  "Nokia",
  "Nubia",
  "Oukitel",
  "Radeon",
  "Razer",
  "Redmi",
  "Sharp",
  "Tecno",
  "Ulefone",
  "Xiaomi",
  "AirPods",
  "Doogee",
  "Galaxy",
  "Google",
  "Каффы",
  "Колье",
  "Кольцо",
  "Конго",
  "Кулон",
  "Люстры",
  "Сотуар",
  "Тиара",
  "Чокер",
  "Шпилька",
  "Apple",
  "ASUS",
  "Браслет",
  "Брошь",
  "Бусы",
  "Диадема",
  "Запонки",
  "Гребень",
  "Люстра",
  "Ноутбук",
  "Серьги",
  "Sony",
  "TCL",
  "Vivo",
  "Xbox",
  "ZTE",
  "AMD",
  "HTC",
  "iPad",
  "iQOO",
  "Lava",
  "MSI",
  "Oppo",
  "Pixel",
  "RTX",
  "TWS",
  "Анклет",
  "NVIDIA",
  "DDR",
  "SSD",
  "HDD",
  "Dyson",
  "Acer",
  "Alcatel",
  "BLU",
  "BQ",
  "Casio",
  "Cat",
  "Cubot",
  "Dell",
  "DJI",
  "Дрон",
  "GoPro",
  "HP",
  "IP-камера",
  "JBL",
  "Кабель USB-C",
  "Кнопочный телефон",
  "LED-лампа",
  "LG",
  "Lightning",
  "Maxcom",
  "Microsoft",
  "Носимое устройство",
  "OTG-переходник",
  "Oura",
  "Plum",
  "Портативная колонка",
  "Портативная рация",
  "Power Bank",
  "Пульсоксиметр",
  "RugGear",
  "Саундбар",
  "Seiko",
  "Смарт-тонометр",
  "Смарт-холодильник",
  "Спутниковый телефон",
  "Steam Deck",
  "Телефон",
  "Tissot",
  "Toshiba",
  "Умная кофеварка",
  "Умная лампа",
  "Умная мультиварка",
  "Умный выключатель",
  "Умный глюкометр",
  "Умный датчик",
  "Умный кондиционер",
  "Умный термостат",
  "Умный чайник",
  "Vertu",
  "Vertex",
  "Веб-камера",
  "Видеокамера",
  "Внешний аккумулятор",
  "Фотоаппарат",
  "GaN-зарядка",
  "HDMI-кабель",
  "Orient",
  "Радиоуправляемая игрушка",
  "Домашний кинотеатр",
  "Умная колонка",
  "VR-шлем",
  "Очки дополненной реальности",
  "XGIMI",
  "Wacom",
  "XP-Pen",
  "Huion",
  "PocketBook",
  "Bookeen",
  "ONYX Boox",
  "Kobo",
  "Essential",
  "BlackBerry",
  "HMD",
];
const LAYOUT_SLOT_MAX = 30;
const LAYOUT_SLOT_MIN = 0;
const MAX_SRC_COL_INDEX = 51;
const PREVIEW_MAX_ROWS = 40;
const MAX_VISIBLE_SOURCE_ROWS = 500000;
const MAX_STATUS_DETAIL_LINES = 24;
const LAYOUT_PREFS_SCHEMA_VERSION = 3;
const TABLE_COLUMNS_EXPORT_KIND = "goodsaudit-table-columns";
const TABLE_COLUMNS_EXPORT_VERSION = 1;
const LAYOUT_DELETION_HISTORY_MAX = 40;
const POPUP_SIZE_DEFAULT = { w: 480, h: 500 };
const POPUP_SIZE_LIMITS = { minW: 360, minH: 380, maxW: 800, maxH: 600 };

let sourceState = {
  mode: "file",
  file: { text: "", fileName: "", fileNames: [], stats: null },
  textInput: "",
};
let outputPrefs = {
  priceThreshold: DEFAULT_PRICE_THRESHOLD,
  minPriceThreshold: DEFAULT_MIN_PRICE_THRESHOLD,
  vulnerableMinPriceThreshold: DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD,
  layoutGe: DEFAULT_LAYOUT_GE.map((fieldId) => ({ type: "field", fieldId })),
  layoutLt: DEFAULT_LAYOUT_LT.map((fieldId) => ({ type: "field", fieldId })),
  opsWarehouses: [],
  threadsChoice: "auto",
  lastManualThreads: 5,
  uiGradient: true,
  aggressiveMode: false,
  excludeMemoryIds: false,
  hyperlinksEnabled: true,
  hyperlinkServiceArticleId: "hub",
  hyperlinkServiceShipment: "hub",
  vulnerabilityKeywords: [...DEFAULT_VULNERABILITY_KEYWORDS],
};
let undoSourceSnapshot = null;
let undoJobSnapshot = null;
let modeUndoJobSnapshot = { file: null, text: null };
const clearedJobModes = new Set();
let layoutDeletionHistory = [];
let lastJobState = null;
let modeWorkspaceState = {
  file: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
  text: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
};
let modeLastJobState = { file: null, text: null };
let logoClicks = [];
let textInputSaveTimer = null;
let resizeRafId = null;
let storageJobRenderRaf = null;
let storageJobPending = null;
let lastStorageJobRenderAt = 0;
let priceThresholdDebounceTimer = null;
let runControlBusy = false;
let prefsAutosaveTimer = null;
let popupPrefsSaveChain = Promise.resolve();
let vulnerabilityKeywordMatcherCacheKey = "";
let vulnerabilityKeywordMatcherEntries = [];
let secretKeywordsModalOpen = false;
let secretKeywordsSearchQuery = "";
let settingsPresets = [];
let selectedPresetId = "";
let activeSourceTextCache = { mode: "", raw: null, value: "" };
let lastPersistedSource = {
  fileText: null,
  fileName: null,
  fileNamesKey: null,
  textInput: null,
};

function cloneForUndo(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pluralizeRu(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  const n100 = n % 100;
  const n10 = n % 10;
  if (n100 >= 11 && n100 <= 19) return many;
  if (n10 === 1) return one;
  if (n10 >= 2 && n10 <= 4) return few;
  return many;
}

function normalizeFileNamesList(fileNames) {
  return (Array.isArray(fileNames) ? fileNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
}

function buildFileNameSummary(fileNames) {
  const names = normalizeFileNamesList(fileNames);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  const extra = names.length - 1;
  return `${names[0]} (+${extra} ${pluralizeRu(extra, "файл", "файла", "файлов")})`;
}

function buildFileNameDisplayHtml(fileName, fileNames) {
  const names = normalizeFileNamesList(fileNames);
  const summary = String(fileName || buildFileNameSummary(names) || "").trim();
  const safeSummary = escapeHtml(summary);
  if (!safeSummary) return "—";
  if (names.length <= 1) return safeSummary;
  const tooltipText = names.map((name, idx) => `${idx + 1}. ${name}`).join("\n");
  const tooltipAttr = escapeHtml(tooltipText).replace(/\n/g, "&#10;");
  return `<span class="source-hint-file-list" title="${tooltipAttr}">${safeSummary}</span>`;
}

function buildFileSourceHintHtml(fileName, rows, missingIdRows, fileNames = []) {
  const fileLabelHtml = buildFileNameDisplayHtml(fileName, fileNames);
  const rowsCount = Math.max(0, Number(rows) || 0);
  const missingCount = Math.max(0, Number(missingIdRows) || 0);
  return (
    `Загружен файл: ${fileLabelHtml}. Строк с ID: ${rowsCount}. Без ID: ${missingCount}.` +
    `<br><span class="source-hint-info">` +
    `ID меньше, чем должно быть? Советуем использовать обогащённый файл ЦУП.` +
    `<br><a class="source-hint-link" href="${CUP_POSTINGS_URL}" target="_blank" rel="noopener noreferrer">Перейти в ЦУП</a>` +
    `</span>`
  );
}

function setUndoEnabled(id, enabled) {
  const el = $(id);
  if (el) el.disabled = !enabled;
}

function getActiveModeKey() {
  return sourceState.mode === "text" ? "text" : "file";
}

function getJobKeyByMode(mode) {
  return mode === "text" ? JOB_KEY_TEXT : JOB_KEY_FILE;
}

function getJobUndoKeyByMode(mode) {
  return mode === "text" ? JOB_UNDO_KEY_TEXT : JOB_UNDO_KEY_FILE;
}

function resetJobProgressUi({ show = false, label = "—" } = {}) {
  const fill = $("progressFill");
  if (fill) {
    fill.classList.remove("is-live");
    fill.style.transition = "none";
    fill.style.width = "0%";
    void fill.offsetWidth;
    fill.style.transition = "";
  }
  if ($("progressLabel")) $("progressLabel").textContent = label;
  if ($("progressCounts")) $("progressCounts").textContent = "";
  const pw = $("progressWrap");
  if (pw) {
    pw.classList.add("is-slot-reserved");
    pw.hidden = !show;
  }
}

function clearResultUiInstant() {
  rowBandCache = { key: "", ge: [], lt: [], below: [], vulnerable: [], all: [] };
  lastJobState = null;
  resetJobProgressUi({ show: false });
  if ($("status")) $("status").textContent = "Результат очищен.";
  previewRequestDateCache = { key: "", value: "" };
  if ($("previewGe")) {
    $("previewGe").textContent = "";
    delete $("previewGe").dataset.deferred;
  }
  if ($("previewLt")) {
    $("previewLt").textContent = "";
    delete $("previewLt").dataset.deferred;
  }
  if ($("previewVulnerable")) {
    $("previewVulnerable").textContent = "";
    delete $("previewVulnerable").dataset.deferred;
  }
  if ($("copyGt10k")) $("copyGt10k").disabled = true;
  if ($("copyLt10k")) $("copyLt10k").disabled = true;
  if ($("copyVulnerable")) $("copyVulnerable").disabled = true;
  if ($("copyAllRows")) $("copyAllRows").disabled = true;
  if ($("copyJobErrors")) $("copyJobErrors").disabled = true;
  if ($("clearJob")) $("clearJob").disabled = true;
  stopJobPoll();
}

function syncTextInputFromTextarea() {
  const ta = $("sourceText");
  if (ta) sourceState.textInput = String(ta.value ?? "");
}

function syncCurrentModeWorkspaceFromGlobals() {
  syncTextInputFromTextarea();
  const mode = getActiveModeKey();
  modeWorkspaceState[mode] = {
    undoSourceSnapshot: cloneForUndo(undoSourceSnapshot),
    hasJobUndo: Boolean(undoJobSnapshot),
    layoutDeletionHistory: restoreLayoutDeletionHistoryFromPrefs(layoutDeletionHistory),
    textInput: String(sourceState.textInput || ""),
  };
}

function applyModeWorkspaceToGlobals(mode) {
  const key = mode === "text" ? "text" : "file";
  const ws = modeWorkspaceState[key] || {};
  undoSourceSnapshot = cloneForUndo(ws.undoSourceSnapshot);
  undoJobSnapshot = modeUndoJobSnapshot[key] || null;
  if (!ws.hasJobUndo && !undoJobSnapshot) undoJobSnapshot = null;
  layoutDeletionHistory = restoreLayoutDeletionHistoryFromPrefs(ws.layoutDeletionHistory);
  setUndoEnabled("undoClearSource", Boolean(undoSourceSnapshot));
  setUndoEnabled("undoClearJob", Boolean(undoJobSnapshot || ws.hasJobUndo));
  updateLayoutDeletedButton();
  const pop = $("layoutDeletedPopover");
  if (pop) {
    pop.hidden = true;
    pop.replaceChildren();
  }
  const btn = $("btnLayoutDeletedColumns");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

async function persistJobUndoSnapshot(mode, job) {
  const key = mode === "text" ? "text" : "file";
  const undoKey = getJobUndoKeyByMode(key);
  modeUndoJobSnapshot[key] = job || null;
  if (getActiveModeKey() === key) undoJobSnapshot = job || null;
  if (!job) {
    await chrome.storage.local.remove(undoKey);
    return;
  }
  await chrome.storage.local.set({ [undoKey]: job });
}

async function loadJobUndoSnapshot(mode) {
  const key = mode === "text" ? "text" : "file";
  if (modeUndoJobSnapshot[key]) return modeUndoJobSnapshot[key];
  if (key === getActiveModeKey() && undoJobSnapshot) return undoJobSnapshot;
  const undoKey = getJobUndoKeyByMode(key);
  const obj = await chrome.storage.local.get(undoKey);
  const job = obj[undoKey] || null;
  if (job) {
    modeUndoJobSnapshot[key] = job;
    if (key === getActiveModeKey()) undoJobSnapshot = job;
  }
  return job;
}

async function migrateLegacyJobUndoFromPrefs(rawWorkspace) {
  const writes = {};
  const stripModes = [];
  for (const mode of ["file", "text"]) {
    const legacy = rawWorkspace?.[mode]?.undoJobSnapshot;
    if (!legacy || typeof legacy !== "object") continue;
    const undoKey = getJobUndoKeyByMode(mode);
    const existing = await chrome.storage.local.get(undoKey);
    if (!existing[undoKey]) writes[undoKey] = legacy;
    modeUndoJobSnapshot[mode] = existing[undoKey] || legacy;
    modeWorkspaceState[mode].hasJobUndo = true;
    stripModes.push(mode);
  }
  if (Object.keys(writes).length) {
    try {
      await chrome.storage.local.set(writes);
    } catch {
    }
  }
  return stripModes.length > 0;
}

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function schedulePopupPrefsSave(delayMs = 220) {
  clearTimeout(prefsAutosaveTimer);
  prefsAutosaveTimer = setTimeout(() => {
    prefsAutosaveTimer = null;
    void savePopupPrefs();
  }, Math.max(0, Number(delayMs) || 0));
}

function flushPendingUiSaveTimers() {
  if (textInputSaveTimer) {
    clearTimeout(textInputSaveTimer);
    textInputSaveTimer = null;
  }
  if (priceThresholdDebounceTimer) {
    clearTimeout(priceThresholdDebounceTimer);
    priceThresholdDebounceTimer = null;
  }
  if (prefsAutosaveTimer) {
    clearTimeout(prefsAutosaveTimer);
    prefsAutosaveTimer = null;
  }
}

function clampPopupSize(w, h) {
  return {
    w: Math.min(POPUP_SIZE_LIMITS.maxW, Math.max(POPUP_SIZE_LIMITS.minW, Math.round(w))),
    h: Math.min(POPUP_SIZE_LIMITS.maxH, Math.max(POPUP_SIZE_LIMITS.minH, Math.round(h))),
  };
}

const POPUP_SIZE_LOCAL_KEY = "goodsAuditPopupSizeV1";

function persistPopupSizeLocal(size) {
  try {
    localStorage.setItem(
      POPUP_SIZE_LOCAL_KEY,
      JSON.stringify({ w: size.w, h: size.h })
    );
  } catch {
  }
}

function applyPopupSize(w, h, opts = {}) {
  const size = clampPopupSize(w, h);
  const wpx = `${size.w}px`;
  const hpx = `${size.h}px`;
  const syncVars = opts.syncVars !== false;
  if (syncVars) {
    document.documentElement.style.setProperty("--popup-w", wpx);
    document.documentElement.style.setProperty("--popup-h", hpx);
  }
  document.documentElement.style.width = wpx;
  document.documentElement.style.height = hpx;
  if (opts.persistLocal !== false && syncVars) {
    persistPopupSizeLocal(size);
  }
  return size;
}

function initPopupResize() {
  const handle = $("popupResizeHandle");
  if (!handle) return;

  let pendingW = 0;
  let pendingH = 0;

  const flushResize = () => {
    resizeRafId = null;
    applyPopupSize(pendingW, pendingH, { syncVars: false });
  };

  const freezeLayoutScroll = () => {
    const scrollEl = getSettingsLayoutScrollEl();
    if (!scrollEl) return null;
    const h = Math.round(scrollEl.getBoundingClientRect().height);
    scrollEl.style.maxHeight = `${h}px`;
    scrollEl.style.height = `${h}px`;
    scrollEl.style.overflow = "hidden";
    return scrollEl;
  };

  const unfreezeLayoutScroll = (scrollEl) => {
    if (!scrollEl) return;
    scrollEl.style.maxHeight = "";
    scrollEl.style.height = "";
    scrollEl.style.overflow = "";
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = document.documentElement.clientWidth;
    const startH = document.documentElement.clientHeight;
    const frozenScroll = freezeLayoutScroll();
    document.body.classList.add("is-resizing");

    let lastX = startX;
    let lastY = startY;
    const onMoveTracked = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      pendingW = startW + (startX - ev.clientX);
      pendingH = startH + (ev.clientY - startY);
      if (resizeRafId == null) {
        resizeRafId = requestAnimationFrame(flushResize);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMoveTracked);
      document.removeEventListener("pointerup", onUp);
      if (resizeRafId != null) {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = null;
      }
      unfreezeLayoutScroll(frozenScroll);
      document.body.classList.remove("is-resizing");
      applyPopupSize(startW + (startX - lastX), startH + (lastY - startY), { syncVars: true });
      void savePopupPrefs();
    };

    document.addEventListener("pointermove", onMoveTracked);
    document.addEventListener("pointerup", onUp);
  };

  handle.addEventListener("pointerdown", onPointerDown);
}

function layoutDeletionBandLabel(prefKey) {
  const t = String(Number(getEffectiveUpperThreshold()) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return prefKey === "layoutLt" ? `${t} <` : `${t} ≥`;
}

function slotTitleForDeletionHistory(slot, outputColLetter) {
  if (slot.type === "source") {
    const src = excelColumnLetter(slot.srcIndex);
    const base = `исходник ${src}`;
    return slot.label ? `${outputColLetter}: ${base} · ${slot.label}` : `${outputColLetter}: ${base}`;
  }
  const f = OUTPUT_FIELDS.find((x) => x.id === slot.fieldId);
  const name = f ? f.label : String(slot.fieldId || "");
  return `${outputColLetter}: ${name}`;
}

function pushLayoutDeletion(prefKey, index, slot) {
  const letter = excelColumnLetter(index);
  const band = layoutDeletionBandLabel(prefKey);
  const title = `${band} · ${slotTitleForDeletionHistory(slot, letter)}`;
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `d${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  layoutDeletionHistory.unshift({
    id,
    prefKey,
    index,
    slot: cloneForUndo(slot),
    title,
  });
  if (layoutDeletionHistory.length > LAYOUT_DELETION_HISTORY_MAX) {
    layoutDeletionHistory.length = LAYOUT_DELETION_HISTORY_MAX;
  }
  updateLayoutDeletedButton();
}

function updateLayoutDeletedButton() {
  const btn = $("btnLayoutDeletedColumns");
  if (!btn) return;
  const n = layoutDeletionHistory.length;
  btn.disabled = n === 0;
  btn.textContent = n ? `Удалённые колонки (${n})…` : "Удалённые колонки…";
}

function setLayoutDeletedPopoverOpen(open) {
  const pop = $("layoutDeletedPopover");
  const btn = $("btnLayoutDeletedColumns");
  if (!pop || !btn) return;
  pop.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    pop.replaceChildren();
    layoutDeletionHistory.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "layout-deleted-row";
      row.dataset.id = entry.id;

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "layout-deleted-restore";
      restore.setAttribute("role", "menuitem");
      restore.textContent = entry.title;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "layout-deleted-remove";
      remove.setAttribute("aria-label", "Удалить навсегда");
      remove.textContent = "×";

      row.append(restore, remove);
      pop.append(row);
    });
    if (layoutDeletionHistory.length) {
      const footer = document.createElement("div");
      footer.className = "layout-deleted-footer";
      const clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.className = "layout-deleted-clear-all btn btn-ghost btn-sm";
      clearAll.textContent = "Удалить всё";
      footer.append(clearAll);
      pop.append(footer);
    }
  }
}

function resetLayoutDeletionHistory() {
  layoutDeletionHistory = [];
  updateLayoutDeletedButton();
  const pop = $("layoutDeletedPopover");
  if (pop) {
    pop.hidden = true;
    pop.replaceChildren();
  }
  const btn = $("btnLayoutDeletedColumns");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

async function restoreLayoutDeletionById(id) {
  const i = layoutDeletionHistory.findIndex((x) => x.id === id);
  if (i < 0) return;
  const entry = layoutDeletionHistory[i];
  const prefKey = entry.prefKey;
  const arr = outputPrefs[prefKey];
  if (arr.length >= LAYOUT_SLOT_MAX) {
    showAppToast("Достигнут лимит колонок (30).", 5000);
    return;
  }
  const idx = Math.min(Math.max(0, entry.index), arr.length);
  arr.splice(idx, 0, normalizeLayoutSlot(entry.slot));
  layoutDeletionHistory.splice(i, 1);
  updateLayoutDeletedButton();
  rebuildLayoutPanel(prefKey === "layoutGe" ? "layoutGeGrid" : "layoutLtGrid");
  await savePopupPrefs();
  await refresh();
}

async function removeLayoutDeletionById(id) {
  const i = layoutDeletionHistory.findIndex((x) => x.id === id);
  if (i < 0) return;
  layoutDeletionHistory.splice(i, 1);
  updateLayoutDeletedButton();
  if (!layoutDeletionHistory.length) {
    setLayoutDeletedPopoverOpen(false);
  } else {
    setLayoutDeletedPopoverOpen(true);
  }
  await savePopupPrefs();
}

async function clearAllLayoutDeletions() {
  resetLayoutDeletionHistory();
  await savePopupPrefs();
}

function scheduleStorageJobRender(job) {
  storageJobPending = job;
  lastStorageJobRenderAt = Date.now();
  if (storageJobRenderRaf != null) return;
  storageJobRenderRaf = requestAnimationFrame(() => {
    storageJobRenderRaf = null;
    const j = storageJobPending;
    storageJobPending = null;
    const mode = getActiveModeKey();
    if (clearedJobModes.has(mode)) {
      if (j) return;
      render(null);
      return;
    }
    void getJob()
      .then((live) => {
        if (clearedJobModes.has(getActiveModeKey())) {
          render(null);
          return;
        }
        render(live || j);
      })
      .catch(() => {
        if (clearedJobModes.has(getActiveModeKey())) return;
        render(j);
      });
  });
}

function getSettingsActiveTab() {
  return $("settingsTabLayout")?.classList.contains("is-active") ? "layout" : "general";
}

function setSettingsTab(tab, opts = {}) {
  const layout = tab === "layout";
  const wasLayout = getSettingsActiveTab() === "layout";
  const genBtn = $("settingsTabGeneral");
  const layBtn = $("settingsTabLayout");
  const genPanel = $("settingsPanelGeneral");
  const layPanel = $("settingsPanelLayout");
  if (genBtn && layBtn) {
    genBtn.classList.toggle("is-active", !layout);
    genBtn.setAttribute("aria-selected", layout ? "false" : "true");
    layBtn.classList.toggle("is-active", layout);
    layBtn.setAttribute("aria-selected", layout ? "true" : "false");
  }
  if (genPanel) genPanel.hidden = layout;
  if (layPanel) layPanel.hidden = !layout;
  if (
    layout &&
    $("panelSettings") &&
    !$("panelSettings").hidden &&
    (opts.forceRebuild || !wasLayout || !layoutPanelsBuilt())
  ) {
    rebuildLayoutPanel("layoutGeGrid", { skipScrollPreserve: true });
    rebuildLayoutPanel("layoutLtGrid", { skipScrollPreserve: true });
  }
  if (
    !layout &&
    $("panelSettings") &&
    !$("panelSettings").hidden &&
    !$("opsWarehousesList")?.childElementCount
  ) {
    renderOpsWarehousesList();
  }
  if (!opts.skipSave) savePopupPrefs();
}

function layoutPanelsBuilt() {
  const ge = $("layoutGeGrid");
  const lt = $("layoutLtGrid");
  return Boolean(ge?.childElementCount && lt?.childElementCount);
}

function randomCaptcha(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  }
  return s;
}

function captchaRandomUnit() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      return arr[0] / 4294967296;
    }
  } catch {
  }
  return Math.random();
}

function captchaRandomBetween(min, max) {
  return min + (max - min) * captchaRandomUnit();
}

function captchaChance(probability) {
  return captchaRandomUnit() < Number(probability);
}

function captchaShuffle(values) {
  const arr = Array.isArray(values) ? values.slice() : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(captchaRandomBetween(0, i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function normalizeCaptchaInput(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "");
}

function paintClearMemoryCaptcha(canvas, expected) {
  const w = 280;
  const h = 52;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#ecf3ff");
  gradient.addColorStop(1, "#f7faff");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  const drawCurves = (strength = 1) => {
    const count = Math.max(6, Math.floor(captchaRandomBetween(8, 14) * strength));
    for (let i = 0; i < count; i++) {
      ctx.strokeStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.12, 0.32).toFixed(3)})`;
      ctx.lineWidth = captchaRandomBetween(0.9, 2.1);
      ctx.beginPath();
      ctx.moveTo(captchaRandomBetween(0, w), captchaRandomBetween(0, h));
      ctx.bezierCurveTo(
        captchaRandomBetween(0, w),
        captchaRandomBetween(-20, h + 20),
        captchaRandomBetween(0, w),
        captchaRandomBetween(-20, h + 20),
        captchaRandomBetween(0, w),
        captchaRandomBetween(0, h)
      );
      ctx.stroke();
    }
  };
  const drawStrokes = (strength = 1) => {
    const count = Math.max(14, Math.floor(captchaRandomBetween(18, 34) * strength));
    for (let i = 0; i < count; i++) {
      const x1 = captchaRandomBetween(0, w);
      const y1 = captchaRandomBetween(0, h);
      const len = captchaRandomBetween(5, 22);
      const angle = captchaRandomBetween(0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.1, 0.34).toFixed(3)})`;
      ctx.lineWidth = captchaRandomBetween(0.8, 1.8);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len);
      ctx.stroke();
    }
  };
  const drawRings = (strength = 1) => {
    const count = Math.max(6, Math.floor(captchaRandomBetween(8, 16) * strength));
    for (let i = 0; i < count; i++) {
      ctx.strokeStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.1, 0.28).toFixed(3)})`;
      ctx.lineWidth = captchaRandomBetween(0.8, 1.6);
      ctx.beginPath();
      ctx.arc(
        captchaRandomBetween(0, w),
        captchaRandomBetween(0, h),
        captchaRandomBetween(2.5, 11),
        captchaRandomBetween(0, Math.PI),
        captchaRandomBetween(Math.PI, Math.PI * 2)
      );
      ctx.stroke();
    }
  };
  const drawGrid = (strength = 1) => {
    const stepX = captchaRandomBetween(9, 16) / Math.max(0.75, strength);
    const stepY = captchaRandomBetween(8, 14) / Math.max(0.75, strength);
    ctx.strokeStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.08, 0.18).toFixed(3)})`;
    ctx.lineWidth = captchaRandomBetween(0.5, 0.9);
    for (let x = captchaRandomBetween(0, stepX); x < w; x += stepX) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + captchaRandomBetween(-8, 8), h);
      ctx.stroke();
    }
    for (let y = captchaRandomBetween(0, stepY); y < h; y += stepY) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + captchaRandomBetween(-6, 6));
      ctx.stroke();
    }
  };
  const drawDots = (strength = 1) => {
    const count = Math.max(18, Math.floor(captchaRandomBetween(26, 52) * strength));
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.08, 0.24).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(
        captchaRandomBetween(2, w - 2),
        captchaRandomBetween(2, h - 2),
        captchaRandomBetween(0.6, 2.1),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  };
  const drawZigZag = (strength = 1) => {
    const count = Math.max(2, Math.floor(captchaRandomBetween(3, 6) * strength));
    for (let i = 0; i < count; i++) {
      const yBase = captchaRandomBetween(4, h - 4);
      const amp = captchaRandomBetween(3, 9);
      const seg = captchaRandomBetween(12, 22);
      ctx.strokeStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.14, 0.34).toFixed(3)})`;
      ctx.lineWidth = captchaRandomBetween(0.8, 1.8);
      ctx.beginPath();
      let x = captchaRandomBetween(-10, 5);
      ctx.moveTo(x, yBase + captchaRandomBetween(-amp, amp));
      let up = captchaChance(0.5);
      while (x < w + 10) {
        x += seg;
        ctx.lineTo(x, yBase + (up ? amp : -amp) + captchaRandomBetween(-2, 2));
        up = !up;
      }
      ctx.stroke();
    }
  };
  const drawBands = (strength = 1) => {
    const count = Math.max(3, Math.floor(captchaRandomBetween(4, 9) * strength));
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = `rgba(0, 91, 255, ${captchaRandomBetween(0.05, 0.14).toFixed(3)})`;
      const bw = captchaRandomBetween(10, 32);
      const bx = captchaRandomBetween(-8, w - 4);
      ctx.save();
      ctx.translate(bx, 0);
      ctx.rotate(captchaRandomBetween(-0.2, 0.2));
      ctx.fillRect(0, 0, bw, h);
      ctx.restore();
    }
  };

  const patternPool = [
    { id: "curves", draw: (strength) => drawCurves(strength) },
    { id: "strokes", draw: (strength) => drawStrokes(strength) },
    { id: "rings", draw: (strength) => drawRings(strength) },
    { id: "grid", draw: (strength) => drawGrid(strength) },
    { id: "dots", draw: (strength) => drawDots(strength) },
    { id: "zigzag", draw: (strength) => drawZigZag(strength) },
    { id: "bands", draw: (strength) => drawBands(strength) },
  ];
  const patternById = new Map(patternPool.map((p) => [p.id, p]));
  const hardProfiles = [
    ["curves", "strokes", "dots", "zigzag"],
    ["grid", "curves", "strokes", "rings", "dots"],
    ["bands", "strokes", "dots", "zigzag", "rings"],
    ["curves", "bands", "grid", "strokes", "dots", "rings"],
    ["curves", "strokes", "bands", "grid", "dots", "zigzag", "rings"],
  ];
  const selectedProfile = hardProfiles[Math.floor(captchaRandomBetween(0, hardProfiles.length))];
  const activePatternIds = new Set(selectedProfile);
  for (const pattern of patternPool) {
    if (captchaChance(0.52)) activePatternIds.add(pattern.id);
  }
  while (activePatternIds.size < 5) {
    activePatternIds.add(patternPool[Math.floor(captchaRandomBetween(0, patternPool.length))].id);
  }
  const activePatterns = captchaShuffle([...activePatternIds])
    .map((id) => patternById.get(id))
    .filter(Boolean);
  const baseStrength = captchaRandomBetween(1.18, 1.75);
  for (const pattern of activePatterns) {
    pattern.draw(baseStrength * captchaRandomBetween(0.85, 1.35));
  }

  ctx.strokeStyle = "#b8ccff";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.font = '800 21px ui-monospace, Consolas, "Cascadia Code", monospace';
  ctx.textBaseline = "middle";
  const letters = [...expected];
  const step = (w - 28) / Math.max(1, letters.length);
  const cy = h / 2;

  letters.forEach((ch, i) => {
    const x = 14 + step * (i + 0.5) + captchaRandomBetween(-4.2, 4.2);
    const y = cy + captchaRandomBetween(-6.5, 6.5);
    const rot = captchaRandomBetween(-0.44, 0.44);
    const scaleX = captchaRandomBetween(0.92, 1.1);
    const scaleY = captchaRandomBetween(0.92, 1.08);
    const palette = ["#005bff", "#0d4fd6", "#0050c4", "#1747a6", "#2d4ea3"];
    ctx.fillStyle = palette[Math.floor(captchaRandomUnit() * palette.length)];
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scaleX, scaleY);
    ctx.textAlign = "center";
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });

  if (captchaChance(0.92)) drawCurves(captchaRandomBetween(0.85, 1.35));
  if (captchaChance(0.88)) drawStrokes(captchaRandomBetween(0.9, 1.45));
  if (captchaChance(0.81)) drawRings(captchaRandomBetween(0.8, 1.3));
  if (captchaChance(0.74)) drawZigZag(captchaRandomBetween(0.8, 1.35));
  if (captchaChance(0.69)) drawBands(captchaRandomBetween(0.7, 1.15));
}

function askClearMemoryCaptcha() {
  return new Promise((resolve) => {
    let expected = randomCaptcha(6);
    const overlay = document.createElement("div");
    overlay.className = "captcha-modal-overlay";

    const card = document.createElement("div");
    card.className = "captcha-modal-card";

    const title = document.createElement("div");
    title.className = "captcha-modal-title";
    title.textContent = "Сброс памяти ID";

    const warn1 = document.createElement("p");
    warn1.className = "captcha-modal-warn captcha-modal-warn--primary";
    warn1.textContent = "Обработанные ID снова пойдут в работу, не как «уже в памяти».";

    const warn2 = document.createElement("p");
    warn2.className = "captcha-modal-warn";
    warn2.textContent = "Введи код с картинки.";

    const codeWrap = document.createElement("div");
    codeWrap.className = "captcha-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "captcha-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.draggable = false;
    paintClearMemoryCaptcha(canvas, expected);

    const blockClip = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const ev of ["copy", "cut", "contextmenu", "dragstart"]) {
      canvas.addEventListener(ev, blockClip, true);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "text";
    input.autocomplete = "off";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.maxLength = 6;
    input.placeholder = "Введите капчу";
    input.className = "captcha-modal-input";
    input.setAttribute("aria-label", "Введите капчу");

    const blockPaste = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    input.addEventListener("paste", blockPaste, true);
    input.addEventListener("drop", blockPaste, true);
    input.addEventListener("dragover", (e) => e.preventDefault(), true);
    input.addEventListener(
      "beforeinput",
      (e) => {
        if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") e.preventDefault();
      },
      true
    );
    input.addEventListener(
      "keydown",
      (e) => {
        const k = e.key?.toLowerCase?.() || "";
        if ((e.ctrlKey || e.metaKey) && k === "v") e.preventDefault();
      },
      true
    );

    input.addEventListener("input", () => {
      const up = String(input.value || "").toUpperCase();
      let next = "";
      for (const ch of up) {
        if (CAPTCHA_CHARS.includes(ch)) next += ch;
      }
      input.value = next.slice(0, 6);
    });

    const actions = document.createElement("div");
    actions.className = "actions captcha-modal-actions";

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "btn btn-secondary btn-sm";
    btnCancel.textContent = "Отмена";

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = "btn btn-danger-outline btn-sm";
    btnOk.textContent = "Сбросить память";

    const errLine = document.createElement("p");
    errLine.className = "captcha-modal-err";
    errLine.hidden = true;
    errLine.setAttribute("role", "alert");

    const trySubmit = () => {
      const got = normalizeCaptchaInput(input.value);
      if (!got) {
        errLine.textContent = "Введи код с картинки.";
        errLine.hidden = false;
        input.focus();
        return;
      }
      if (got === expected) {
        cleanup(true);
        return;
      }
      expected = randomCaptcha(6);
      paintClearMemoryCaptcha(canvas, expected);
      errLine.textContent = "Неверно. Код обновлён, попробуй ещё раз.";
      errLine.hidden = false;
      input.value = "";
      input.focus();
    };

    const cleanup = (ok) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(Boolean(ok));
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.repeat) return;
        trySubmit();
      }
    };

    btnCancel.addEventListener("click", () => cleanup(false));
    btnOk.addEventListener("click", trySubmit);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });

    codeWrap.append(canvas);
    actions.append(btnCancel, btnOk);
    card.append(title, warn1, warn2, errLine, codeWrap, input, actions);
    overlay.append(card);
    document.body.append(overlay);
    document.addEventListener("keydown", onKeyDown, true);
    input.focus();
  });
}

function escapeTsvCell(value) {
  const s = String(value ?? "");
  const looksLikeDate =
    /^\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(s.trim()) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s.trim());
  if (looksLikeDate || /[\t\n\r",;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HUB_LOZON_ITEM_URL = "https://hub.o3t.ru/management/stock/item/Lozon:";
const ASC_ARTICLE_URL = "https://returns.o3t.ru/items/article/";
const TOUCH_TRACKING_URL = "https://touch-tracking.o3t.ru/?articleIdOrBarcode=";
const HYPERLINK_SERVICES = ["hub", "asc", "touch"];

function normalizeHyperlinkService(value) {
  const v = String(value || "").trim().toLowerCase();
  return HYPERLINK_SERVICES.includes(v) ? v : "hub";
}

function areHyperlinksEnabled() {
  return outputPrefs.hyperlinksEnabled !== false;
}

function hubLozonUrl(lozonId) {
  const id = String(lozonId || "").trim();
  if (!id) return "";
  return `${HUB_LOZON_ITEM_URL}${encodeURIComponent(id)}`;
}

function ascArticleUrl(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  return `${ASC_ARTICLE_URL}${encodeURIComponent(id)}`;
}

function touchTrackingUrl(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  return `${TOUCH_TRACKING_URL}${encodeURIComponent(id)}`;
}

function buildServiceHyperlinkUrl(service, value) {
  const id = String(value || "").trim();
  if (!id) return "";
  switch (normalizeHyperlinkService(service)) {
    case "asc":
      return ascArticleUrl(id);
    case "touch":
      return touchTrackingUrl(id);
    case "hub":
    default:
      if (!/^\d{10,35}$/.test(id)) return "";
      return hubLozonUrl(id);
  }
}

function lozonIdForRow(row) {
  const id = String(row?.articleId || "").trim();
  if (/^\d{10,35}$/.test(id)) return id;
  const fetchId = String(row?.fetchArticleId || "").trim();
  if (/^\d{10,35}$/.test(fetchId)) return fetchId;
  return id;
}

function hyperlinkTargetForSlot(slot, row) {
  const service =
    slot?.fieldId === "shipment"
      ? normalizeHyperlinkService(outputPrefs.hyperlinkServiceShipment)
      : normalizeHyperlinkService(outputPrefs.hyperlinkServiceArticleId);
  if (service === "hub") {
    return lozonIdForRow(row);
  }
  if (slot?.fieldId === "shipment") {
    return (
      String(row?.shipment || "").trim() ||
      lozonIdForRow(row) ||
      String(row?.articleId || "").trim()
    );
  }
  return lozonIdForRow(row) || String(row?.articleId || "").trim();
}

function hyperlinkServiceForSlot(slot) {
  if (slot?.fieldId === "shipment") {
    return normalizeHyperlinkService(outputPrefs.hyperlinkServiceShipment);
  }
  return normalizeHyperlinkService(outputPrefs.hyperlinkServiceArticleId);
}

function isHyperlinkOutputSlot(slot) {
  return slot?.type === "field" && (slot.fieldId === "articleId" || slot.fieldId === "shipment");
}

function excelHyperlinkFormula(url, display) {
  const u = String(url || "").replace(/"/g, '""');
  const d = String(display || "").replace(/"/g, '""');
  return `=ГИПЕРССЫЛКА("${u}";"${d}")`;
}

function cellExportValue(slot, row, requestDateStr, sourceDataByArticleId) {
  const text = String(cellValueFromSlot(slot, row, requestDateStr, sourceDataByArticleId) ?? "");
  if (!text || !isHyperlinkOutputSlot(slot)) return text;
  if (!areHyperlinksEnabled()) return text;
  const href = buildServiceHyperlinkUrl(hyperlinkServiceForSlot(slot), hyperlinkTargetForSlot(slot, row));
  if (!href) return text;
  return excelHyperlinkFormula(href, text);
}

function nowRequestDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let previewRequestDateCache = { key: "", value: "" };

function getPreviewRequestDateStr(job) {
  const results = job?.results;
  const n = Array.isArray(results) ? results.length : Number(job?.resultsCount) || 0;
  const lastId =
    Array.isArray(results) && results.length
      ? String(results[results.length - 1]?.articleId || "")
      : "";
  const key = [getActiveModeKey(), job?.phase || "", n, lastId].join("\u0001");
  if (previewRequestDateCache.key !== key || !previewRequestDateCache.value) {
    previewRequestDateCache = { key, value: nowRequestDateStr() };
  }
  return previewRequestDateCache.value;
}

function setPreviewTextIfChanged(el, nextText) {
  if (!el) return;
  const text = String(nextText ?? "");
  if (el.textContent === text) return;
  el.textContent = text;
}

function getPriceThreshold() {
  const n = Number(outputPrefs.priceThreshold);
  return Number.isFinite(n) ? n : DEFAULT_PRICE_THRESHOLD;
}

function getMinPriceThreshold() {
  const n = Number(outputPrefs.minPriceThreshold);
  if (!Number.isFinite(n)) return DEFAULT_MIN_PRICE_THRESHOLD;
  return Math.max(0, n);
}

function getVulnerableMinPriceThreshold() {
  const n = Number(outputPrefs.vulnerableMinPriceThreshold);
  if (!Number.isFinite(n)) return DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD;
  return Math.max(0, n);
}

function getEffectiveUpperThreshold() {
  return Math.max(getPriceThreshold(), getMinPriceThreshold());
}

const MANUAL_THREADS_MAX = 25;
const MANUAL_THREADS_DEFAULT = 5;

function normalizeThreadsChoice(value) {
  const raw = String(value ?? "auto").trim().toLowerCase();
  if (raw === "auto" || raw === "" || raw === "0") return "auto";
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return "auto";
  return String(Math.min(MANUAL_THREADS_MAX, n));
}

function normalizeManualThreadsValue(value, fallback = MANUAL_THREADS_DEFAULT) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MANUAL_THREADS_MAX, n);
}

function getManualThreadsCount() {
  const choice = normalizeThreadsChoice(outputPrefs.threadsChoice);
  return choice === "auto" ? 0 : Number(choice);
}

function getLastManualThreads() {
  return normalizeManualThreadsValue(outputPrefs.lastManualThreads, MANUAL_THREADS_DEFAULT);
}

function applyThreadsChoiceToDom() {
  const modeSelect = $("threadsMode");
  const manualInput = $("threadsManual");
  if (!modeSelect || !manualInput) return;
  const choice = normalizeThreadsChoice(outputPrefs.threadsChoice);
  const isManual = choice !== "auto";
  const mode = isManual ? "manual" : "auto";
  if (modeSelect.value !== mode) modeSelect.value = mode;
  const count = isManual ? Number(choice) : getLastManualThreads();
  if (manualInput.value !== String(count)) manualInput.value = String(count);
  manualInput.hidden = !isManual;
}

function getOpsWarehousesList(opts = {}) {
  const keepEmpty = Boolean(opts.keepEmpty);
  if (!Array.isArray(outputPrefs.opsWarehouses)) return [];
  const arr = outputPrefs.opsWarehouses.map((x) => String(x ?? ""));
  return keepEmpty ? arr : arr.map((x) => x.trim()).filter(Boolean);
}

function normalizeVulnerabilityKeyword(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sanitizeVulnerabilityKeywords(values, opts = {}) {
  const allowEmpty = opts.allowEmpty === true;
  const source = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    const keyword = normalizeVulnerabilityKeyword(raw);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  if (out.length) return out;
  if (allowEmpty) return [];
  return [...DEFAULT_VULNERABILITY_KEYWORDS];
}

function getVulnerabilityKeywordsList() {
  if (Array.isArray(outputPrefs.vulnerabilityKeywords)) {
    return sanitizeVulnerabilityKeywords(outputPrefs.vulnerabilityKeywords, { allowEmpty: true });
  }
  return [...DEFAULT_VULNERABILITY_KEYWORDS];
}

function getVisibleVulnerabilityKeywordEntries() {
  const values = getVulnerabilityKeywordsList();
  const query = normalizeVulnerabilityText(secretKeywordsSearchQuery);
  const all = values.map((keyword, index) => ({ keyword, index }));
  if (!query) return all;
  const queryTokens = query.split(" ").filter(Boolean);
  if (!queryTokens.length) return all;
  return all.filter((entry) => {
    const normalizedKeyword = normalizeVulnerabilityText(entry.keyword);
    return queryTokens.every((token) => normalizedKeyword.includes(token));
  });
}

function normalizeOpsWarehouseName(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMatchingOpsWarehouse(row) {
  const ops = getOpsWarehousesList();
  if (!ops.length) return true;
  const place = normalizeOpsWarehouseName(row?.operationalWarehouse);
  if (!place) return false;
  const known = ops.map(normalizeOpsWarehouseName).filter(Boolean);
  if (!known.length) return true;
  if (known.some((w) => w === place)) return true;
  const parts = place
    .split(/\s+[—-]\s+/)
    .map(normalizeOpsWarehouseName)
    .filter(Boolean);
  return parts.some((part) => known.includes(part));
}

function filterRowsByOpsWarehouse(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ops = getOpsWarehousesList();
  if (!ops.length) return list;
  return list.filter((row) => hasMatchingOpsWarehouse(row));
}

function createDeleteButton({ ariaLabel = "Удалить", disabled = false, small = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = small ? "deleteButton deleteButton--sm" : "deleteButton";
  btn.setAttribute("aria-label", ariaLabel);
  btn.disabled = Boolean(disabled);
  btn.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 50 59" class="bin" aria-hidden="true">` +
    `<path fill="#B5BAC1" d="M0 7.5C0 5.01472 2.01472 3 4.5 3H45.5C47.9853 3 50 5.01472 50 7.5V7.5C50 8.32843 49.3284 9 48.5 9H1.5C0.671571 9 0 8.32843 0 7.5V7.5Z"></path>` +
    `<path fill="#B5BAC1" d="M17 3C17 1.34315 18.3431 0 20 0H29.3125C30.9694 0 32.3125 1.34315 32.3125 3V3H17V3Z"></path>` +
    `<path fill="#B5BAC1" d="M2.18565 18.0974C2.08466 15.821 3.903 13.9202 6.18172 13.9202H43.8189C46.0976 13.9202 47.916 15.821 47.815 18.0975L46.1699 55.1775C46.0751 57.3155 44.314 59.0002 42.1739 59.0002H7.8268C5.68661 59.0002 3.92559 57.3155 3.83073 55.1775L2.18565 18.0974ZM18.0003 49.5402C16.6196 49.5402 15.5003 48.4209 15.5003 47.0402V24.9602C15.5003 23.5795 16.6196 22.4602 18.0003 22.4602C19.381 22.4602 20.5003 23.5795 20.5003 24.9602V47.0402C20.5003 48.4209 19.381 49.5402 18.0003 49.5402ZM29.5003 47.0402C29.5003 48.4209 30.6196 49.5402 32.0003 49.5402C33.381 49.5402 34.5003 48.4209 34.5003 47.0402V24.9602C34.5003 23.5795 33.381 22.4602 32.0003 22.4602C30.6196 22.4602 29.5003 23.5795 29.5003 24.9602V47.0402Z" clip-rule="evenodd" fill-rule="evenodd"></path>` +
    `<path fill="#B5BAC1" d="M2 13H48L47.6742 21.28H2.32031L2 13Z"></path>` +
    `</svg>`;
  return btn;
}

function renderOpsWarehousesList() {
  const root = $("opsWarehousesList");
  if (!root) return;
  root.replaceChildren();
  const values = getOpsWarehousesList({ keepEmpty: true });
  const safeValues = values.length ? values : [""];
  safeValues.forEach((value, idx) => {
    const row = document.createElement("div");
    row.className = "ops-list-row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "Например: МО_ИСТРА_ХАБ";
    inp.value = value;
    inp.addEventListener("input", () => {
      const arr = getOpsWarehousesList({ keepEmpty: true });
      while (arr.length < safeValues.length) arr.push("");
      arr[idx] = String(inp.value || "");
      outputPrefs.opsWarehouses = arr;
      schedulePopupPrefsSave(180);
    });
    inp.addEventListener("blur", async () => {
      const arr = getOpsWarehousesList({ keepEmpty: true });
      arr[idx] = String(inp.value || "");
      outputPrefs.opsWarehouses = arr.length ? arr : [""];
      await savePopupPrefs();
    });
    const rm = createDeleteButton({
      ariaLabel: "Удалить",
      disabled: safeValues.length <= 1,
    });
    rm.addEventListener("click", async () => {
      const arr = getOpsWarehousesList({ keepEmpty: true });
      if (arr.length <= 1) {
        outputPrefs.opsWarehouses = [""];
      } else {
        arr.splice(idx, 1);
        outputPrefs.opsWarehouses = arr;
      }
      renderOpsWarehousesList();
      await savePopupPrefs();
    });
    row.append(inp, rm);
    root.append(row);
  });
}

function renderVulnerabilityKeywordsList(rootId = "secretKeywordsList") {
  const root = $(rootId);
  if (!root) return;
  root.replaceChildren();
  const entries = getVisibleVulnerabilityKeywordEntries();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "secret-keywords-empty";
    empty.textContent = secretKeywordsSearchQuery
      ? "По запросу ничего не найдено."
      : "Список кейвордов пуст. Добавь новый кейворд.";
    root.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const idx = entry.index;
    const row = document.createElement("div");
    row.className = "secret-keywords-row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "Кейворд уязвимости";
    inp.value = entry.keyword;
    inp.addEventListener("input", () => {
      const arr = getVulnerabilityKeywordsList();
      while (arr.length <= idx) arr.push("");
      arr[idx] = normalizeVulnerabilityKeyword(inp.value);
      outputPrefs.vulnerabilityKeywords = arr;
      vulnerabilityKeywordMatcherCacheKey = "";
      schedulePopupPrefsSave(180);
      void refresh();
    });
    inp.addEventListener("blur", async () => {
      const arr = getVulnerabilityKeywordsList();
      while (arr.length <= idx) arr.push("");
      arr[idx] = normalizeVulnerabilityKeyword(inp.value);
      outputPrefs.vulnerabilityKeywords = sanitizeVulnerabilityKeywords(arr, { allowEmpty: true });
      vulnerabilityKeywordMatcherCacheKey = "";
      renderVulnerabilityKeywordsList(rootId);
      await savePopupPrefs();
      await refresh();
    });
    const rm = createDeleteButton({ ariaLabel: "Удалить" });
    rm.addEventListener("click", async () => {
      const arr = getVulnerabilityKeywordsList();
      if (idx < 0 || idx >= arr.length) return;
      arr.splice(idx, 1);
      outputPrefs.vulnerabilityKeywords = sanitizeVulnerabilityKeywords(arr, { allowEmpty: true });
      vulnerabilityKeywordMatcherCacheKey = "";
      renderVulnerabilityKeywordsList(rootId);
      await savePopupPrefs();
      await refresh();
    });
    row.append(inp, rm);
    root.append(row);
  });
}

function layoutStringsToSlots(ids) {
  return ids.map((fieldId) => ({ type: "field", fieldId }));
}

function excelColumnLetter(index) {
  let n = Math.floor(Number(index) || 0) + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

function normalizeLayoutSlot(x) {
  if (x == null) return { type: "field", fieldId: "empty" };
  if (typeof x === "string") {
    const allowed = new Set(OUTPUT_FIELDS.map((f) => f.id));
    return { type: "field", fieldId: allowed.has(x) ? x : "empty" };
  }
  if (typeof x !== "object") return { type: "field", fieldId: "empty" };
  if (x.type === "source" && Number.isFinite(Number(x.srcIndex))) {
    const idx = Math.min(MAX_SRC_COL_INDEX, Math.max(0, Math.floor(Number(x.srcIndex))));
    return { type: "source", srcIndex: idx, label: String(x.label || "").trim() };
  }
  const fid = String(x.fieldId || x.id || "empty");
  const allowed = new Set(OUTPUT_FIELDS.map((f) => f.id));
  if (allowed.has(fid)) return { type: "field", fieldId: fid };
  return { type: "field", fieldId: "empty" };
}

function migrateLayoutToSlots(raw, fallbackIds) {
  if (raw == null || !Array.isArray(raw)) {
    return layoutStringsToSlots(fallbackIds).map((s) => ({ ...s }));
  }
  if (raw.length === 0) {
    return [];
  }
  if (raw.every((x) => typeof x === "string")) {
    const allowed = new Set(OUTPUT_FIELDS.map((f) => f.id));
    return raw.map((id) => ({
      type: "field",
      fieldId: allowed.has(String(id)) ? String(id) : "empty",
    }));
  }
  return raw.map((x) => normalizeLayoutSlot(x));
}

function clampSlotsLength(slots, fallbackIds) {
  let s = Array.isArray(slots) ? slots.map((x) => ({ ...normalizeLayoutSlot(x) })) : [];
  if (s.length === 0) return [];
  if (s.length > LAYOUT_SLOT_MAX) s = s.slice(0, LAYOUT_SLOT_MAX);
  while (s.length < LAYOUT_SLOT_MIN) {
    s.push({ type: "field", fieldId: "empty" });
  }
  return s;
}

function slotToSelectValue(slot) {
  if (slot.type === "source") return `src:${slot.srcIndex}`;
  return `f:${slot.fieldId || "empty"}`;
}

function parseSelectValue(v) {
  const key = String(v || "");
  if (key.startsWith("src:")) {
    const idx = Math.floor(Number(key.slice(4)) || 0);
    return {
      type: "source",
      srcIndex: Math.min(MAX_SRC_COL_INDEX, Math.max(0, idx)),
      label: "",
    };
  }
  const id = key.startsWith("f:") ? key.slice(2) : key;
  const allowed = new Set(OUTPUT_FIELDS.map((f) => f.id));
  return { type: "field", fieldId: allowed.has(id) ? id : "empty" };
}

function getNormalizedSlotsForKind(kind) {
  const fallback = kind === "lt10k" ? DEFAULT_LAYOUT_LT : DEFAULT_LAYOUT_GE;
  const prefKey = kind === "lt10k" ? "layoutLt" : "layoutGe";
  return clampSlotsLength(migrateLayoutToSlots(outputPrefs[prefKey], fallback), fallback);
}

function getLayoutKindWithMoreColumns() {
  const geLen = getNormalizedSlotsForKind("ge10k").length;
  const ltLen = getNormalizedSlotsForKind("lt10k").length;
  return ltLen > geLen ? "lt10k" : "ge10k";
}

function slotsNeedSourceCells(slots) {
  return Array.isArray(slots) && slots.some((slot) => slot?.type === "source");
}

function getNamedSourceValue(fieldId, sourceNamed, row) {
  const named = sourceNamed && typeof sourceNamed === "object" ? sourceNamed : null;
  if (!named) return "";
  switch (fieldId) {
    case "operationalWarehouse":
      return String(named.operationalWarehouse || "");
    case "articleId":
      return String(named.articleId || "");
    case "shipment":
      return String(named.shipment || "");
    default:
      return "";
  }
}

function fieldValueById(fieldId, row, requestDateStr, sourceNamed) {
  const namedVal =
    fieldId === "operationalWarehouse" || fieldId === "articleId" || fieldId === "shipment"
      ? getNamedSourceValue(fieldId, sourceNamed, row)
      : "";
  switch (fieldId) {
    case "requestDate":
      return requestDateStr;
    case "operationalWarehouse":
      return namedVal || String(row.operationalWarehouse || row.warehouse || "");
    case "articleId": {
      const scraped = String(row.articleId || "").trim();
      if (/^\d{10,35}$/.test(scraped)) return scraped;
      if (scraped) return scraped;
      return namedVal || "";
    }
    case "shipment": {
      const scraped = String(row.shipment || "").trim();
      if (scraped) return scraped;
      return namedVal || "";
    }
    case "nomenclature":
      return String(row.nomenclature || "");
    case "price":
      return String(row.price ?? "").replace(".", ",");
    case "activeStatus":
      return String(row.activeStatus || row.status || "");
    case "statusLozon":
      return String(row.statusLozon || "");
    case "statusAlps":
      return String(row.statusAlps || "");
    case "deliveryScheme":
      return String(row.deliveryScheme || "");
    case "formationWarehouse":
      return String(row.formationWarehouse || "");
    case "owner":
      return String(row.owner || "");
    case "vulnerabilityTriggerKeyword":
      return getVulnerabilityTriggerKeyword(row?.nomenclature || "");
    default:
      return "";
  }
}

function cellValueFromSlot(slot, row, requestDateStr, sourceDataByArticleId) {
  const sourceMap = sourceDataByArticleId?.rowsByArticle || null;
  const headerLookup = sourceDataByArticleId?.headerLookup || null;
  const sourceData = findSourceDataForRow(row, sourceMap);
  if (slot.type === "source") {
    let cells = Array.isArray(row.sourceCells) ? row.sourceCells : null;
    if ((cells == null || cells.length === 0) && sourceData) {
      cells = sourceData.cells;
    }
    if (!Array.isArray(cells)) return "";
    const idx = Math.min(MAX_SRC_COL_INDEX, Math.max(0, Math.floor(Number(slot.srcIndex)) || 0));
    const byIndex = idx < cells.length ? String(cells[idx] ?? "").trim() : "";
    if (byIndex) return byIndex;
    const headerName = String(slot.label || "").trim();
    if (!headerName) return "";
    const fallbackIdx = headerLookup?.get(normalizeHeaderLookupName(headerName));
    if (!Number.isFinite(fallbackIdx) || fallbackIdx < 0) return "";
    return fallbackIdx < cells.length ? String(cells[fallbackIdx] ?? "").trim() : "";
  }
  return fieldValueById(slot.fieldId || "empty", row, requestDateStr, sourceData?.named || null);
}

function buildTsvFromResults(rows, kind = "ge10k") {
  if (!rows?.length) return "";
  const requestDateStr = nowRequestDateStr();
  const slots = getNormalizedSlotsForKind(kind);
  const sourceDataByArticleId = getExportSourceDataByArticleId();
  const line = (r) =>
    slots.map((slot) =>
      escapeTsvCell(cellExportValue(slot, r, requestDateStr, sourceDataByArticleId))
    );
  return rows.map((r) => line(r).join("\t")).join("\n");
}

function buildPreviewTsv(rows, kind, requestDateStr) {
  if (!rows?.length) return "";
  const limit = Math.max(1, PREVIEW_MAX_ROWS);
  const cut = rows.length > limit;
  const visibleRows = cut ? rows.slice(0, limit) : rows;
  const dateStr = requestDateStr || previewRequestDateCache.value || nowRequestDateStr();
  const slots = getNormalizedSlotsForKind(kind);
  const sourceDataByArticleId = getExportSourceDataByArticleId();
  const body = visibleRows
    .map((row) => {
      const cells = slots
        .map((slot) => String(cellValueFromSlot(slot, row, dateStr, sourceDataByArticleId) ?? "").trim())
        .filter(Boolean);
      return cells.join(" | ");
    })
    .join("\n");
  if (!cut) return body;
  return `${body}\n…ещё ${rows.length - limit} строк(и). Полный объём доступен по кнопке «Копировать».`;
}

async function getJob() {
  const mode = getActiveModeKey();
  if (clearedJobModes.has(mode)) return null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_JOB", sourceMode: mode });
    if (res?.ok) return res.job || null;
  } catch {}
  const jobKey = getJobKeyByMode(mode);
  const { [jobKey]: job } = await chrome.storage.local.get(jobKey);
  return job || null;
}

async function getProcessedSet() {
  const { [PROCESSED_KEY]: arr } = await chrome.storage.local.get(PROCESSED_KEY);
  return new Set(Array.isArray(arr) ? arr : []);
}

async function addProcessedIds(ids) {
  const set = await getProcessedSet();
  for (const id of ids) set.add(id);
  await chrome.storage.local.set({ [PROCESSED_KEY]: [...set] });
}

let rowBandCache = {
  key: "",
  ge: [],
  lt: [],
  below: [],
  vulnerable: [],
  all: [],
};

function getRowBandCacheKey(job) {
  const results = job?.results;
  const n = Array.isArray(results) ? results.length : Number(job?.resultsCount) || 0;
  const lastId = Array.isArray(results) && results.length ? String(results[results.length - 1]?.articleId || "") : "";
  return [
    getActiveModeKey(),
    job?.phase || "",
    n,
    lastId,
    getMinPriceThreshold(),
    getEffectiveUpperThreshold(),
    getVulnerableMinPriceThreshold(),
    getOpsWarehousesList().join("|"),
    outputPrefs.excludeMemoryIds === true ? "1" : "0",
    vulnerabilityKeywordMatcherCacheKey,
  ].join("\u0001");
}

function getMemoryArticleIdSet(job) {
  const set = new Set();
  const skipped = Array.isArray(job?.skippedMem) ? job.skippedMem : [];
  for (const line of skipped) {
    const text = String(line || "").trim();
    if (!text) continue;
    const m = text.match(/Уже в памяти:\s*(.+)$/i);
    if (m && m[1]) set.add(String(m[1]).trim());
  }
  return set;
}

function isResultFromMemory(row, memoryIds) {
  if (!row || typeof row !== "object") return false;
  if (row.fromMemory === true) return true;
  const id = String(row.articleId || "").trim();
  const fetchId = String(row.fetchArticleId || "").trim();
  if (id && memoryIds.has(id)) return true;
  if (fetchId && memoryIds.has(fetchId)) return true;
  return false;
}

function filterRowsExcludeMemory(rows, job) {
  if (outputPrefs.excludeMemoryIds !== true) return rows;
  const memoryIds = getMemoryArticleIdSet(job);
  return (Array.isArray(rows) ? rows : []).filter((row) => !isResultFromMemory(row, memoryIds));
}

function ensureRowBands(job) {
  const key = getRowBandCacheKey(job);
  if (rowBandCache.key === key) return rowBandCache;
  const all = filterRowsExcludeMemory(filterRowsByOpsWarehouse(job?.results || []), job);
  const min = getMinPriceThreshold();
  const upper = getEffectiveUpperThreshold();
  const vulnerableMin = getVulnerableMinPriceThreshold();
  const ge = [];
  const lt = [];
  const below = [];
  const vulnerable = [];
  for (const r of all) {
    const price = Number(r?.price);
    if (!Number.isFinite(price) || price < min) {
      if (Number.isFinite(price) && price < min) below.push(r);
    } else if (price >= upper) {
      ge.push(r);
    } else {
      lt.push(r);
    }
    if (isVulnerableByNomenclature(r?.nomenclature || "")) {
      if (vulnerableMin <= 0 || (Number.isFinite(price) && price >= vulnerableMin)) {
        vulnerable.push(r);
      }
    }
  }
  rowBandCache = { key, ge, lt, below, vulnerable, all };
  return rowBandCache;
}

function rowsGe10k(job) {
  return ensureRowBands(job).ge;
}

function rowsLt10k(job) {
  return ensureRowBands(job).lt;
}

function rowsBelowMin(job) {
  return ensureRowBands(job).below;
}

function normalizeVulnerabilityText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getVulnerabilityMatcherEntries() {
  const list = getVulnerabilityKeywordsList();
  const key = list.map((x) => x.toLowerCase()).join("\n");
  if (key === vulnerabilityKeywordMatcherCacheKey) return vulnerabilityKeywordMatcherEntries;
  const entries = [];
  for (const keyword of list) {
    const normalized = normalizeVulnerabilityText(keyword);
    if (!normalized) continue;
    const tokens = normalized.split(" ").filter(Boolean);
    if (!tokens.length) continue;
    entries.push({
      keyword,
      normalized,
      tokens,
      tokenLen: tokens.length,
    });
  }
  vulnerabilityKeywordMatcherCacheKey = key;
  vulnerabilityKeywordMatcherEntries = entries;
  return entries;
}

function hasTokensSequence(tokens, sequence) {
  if (!Array.isArray(tokens) || !Array.isArray(sequence)) return false;
  if (!tokens.length || !sequence.length || sequence.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - sequence.length; i++) {
    let ok = true;
    for (let j = 0; j < sequence.length; j++) {
      if (tokens[i + j] !== sequence[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function getVulnerabilityTriggerKeyword(nomenclature) {
  const normalized = normalizeVulnerabilityText(nomenclature);
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter(Boolean);
  const matcherEntries = getVulnerabilityMatcherEntries();
  for (const entry of matcherEntries) {
    if (entry.tokenLen === 1) {
      if (tokens.includes(entry.tokens[0])) return entry.keyword;
      continue;
    }
    if (hasTokensSequence(tokens, entry.tokens)) return entry.keyword;
  }
  return "";
}

function isVulnerableByNomenclature(nomenclature) {
  return Boolean(getVulnerabilityTriggerKeyword(nomenclature));
}

function rowsVulnerable(job) {
  return ensureRowBands(job).vulnerable;
}

function rowsAll(job) {
  return ensureRowBands(job).all;
}
const getActiveSourceText = () => {
  const mode = sourceState.mode === "file" ? "file" : "text";
  const raw = mode === "file" ? sourceState.file.text : String(sourceState.textInput || "");
  // Мемоизация: render() дёргает эту функцию очень часто, а разбор больших
  // исходников (сотни тысяч строк) на каждый вызов подвешивал попап.
  if (activeSourceTextCache.mode === mode && activeSourceTextCache.raw === raw) {
    return activeSourceTextCache.value;
  }
  const splitRecords =
    typeof globalThis.__returnsSplitCsvRecords === "function"
      ? globalThis.__returnsSplitCsvRecords
      : null;
  let value;
  if (splitRecords) {
    value = splitRecords(raw).join("\n").trim();
  } else {
    value = String(raw || "")
      .split(/\r?\n/)
      .filter((line) => {
        const t = String(line || "").trim();
        if (!t) return false;
        if (/^[\t;,]+$/.test(t)) return false;
        return true;
      })
      .join("\n")
      .trim();
  }
  activeSourceTextCache = { mode, raw, value };
  return value;
};

let exportSourceDataMapKey = "";
let exportSourceDataMap = null;
let layoutPreviewRefreshTimer = null;

function invalidateExportSourceDataCache() {
  exportSourceDataMapKey = "";
  exportSourceDataMap = null;
}

function entriesFromMapLike(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()];
  if (typeof value.entries === "function") {
    try {
      return [...value.entries()];
    } catch {
    }
  }
  if (Array.isArray(value)) {
    return value
      .filter((pair) => Array.isArray(pair) && pair.length >= 2)
      .map((pair) => [pair[0], pair[1]]);
  }
  if (typeof value === "object") return Object.entries(value);
  return [];
}

function ensureSourceExportDataShape(exportData) {
  if (!exportData || typeof exportData !== "object") return null;
  const headerCells = Array.isArray(exportData.headerCells)
    ? exportData.headerCells.map((x) => String(x ?? ""))
    : [];
  let rowsByArticle = exportData.rowsByArticle;
  if (!(rowsByArticle instanceof Map)) {
    rowsByArticle = new Map(entriesFromMapLike(rowsByArticle));
  }
  if (!rowsByArticle.size && !Array.isArray(exportData.rows)) return null;
  if (!rowsByArticle.size && Array.isArray(exportData.rows)) {
    return deserializeSourceExportData(exportData);
  }
  let headerLookup = exportData.headerLookup;
  if (!(headerLookup instanceof Map)) {
    headerLookup = new Map(
      entriesFromMapLike(headerLookup).map(([k, v]) => [String(k || ""), Number(v) || 0])
    );
  }
  if (!headerLookup.size && headerCells.length) {
    headerLookup = buildHeaderLookupIndex(headerCells);
  }
  return {
    sourceTextKey: String(exportData.sourceTextKey || ""),
    headerCells,
    headerLookup,
    rowsByArticle,
  };
}

function serializeSourceExportData(exportData) {
  const shaped = ensureSourceExportDataShape(exportData);
  if (!shaped?.rowsByArticle) return null;
  return {
    sourceTextKey: String(shaped.sourceTextKey || ""),
    headerCells: Array.isArray(shaped.headerCells) ? shaped.headerCells.map((x) => String(x ?? "")) : [],
    headerLookup: entriesFromMapLike(shaped.headerLookup),
    rows: entriesFromMapLike(shaped.rowsByArticle).map(([articleId, row]) => [
      String(articleId || ""),
      {
        cells: Array.isArray(row?.cells) ? row.cells.map((x) => String(x ?? "")) : [],
        named: row?.named && typeof row.named === "object" ? { ...row.named } : null,
      },
    ]),
  };
}

function deserializeSourceExportData(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.rowsByArticle && !Array.isArray(raw.rows)) {
    return ensureSourceExportDataShape(raw);
  }
  if (!Array.isArray(raw.rows)) return null;
  const rowsByArticle = new Map();
  for (const entry of raw.rows) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const articleId = String(entry[0] || "").trim();
    if (!articleId) continue;
    const payload = entry[1] && typeof entry[1] === "object" ? entry[1] : {};
    rowsByArticle.set(articleId, {
      cells: Array.isArray(payload.cells) ? payload.cells.map((x) => String(x ?? "")) : [],
      named: payload.named && typeof payload.named === "object" ? payload.named : null,
    });
  }
  const headerCells = Array.isArray(raw.headerCells) ? raw.headerCells.map((x) => String(x ?? "")) : [];
  let headerLookup = new Map(
    Array.isArray(raw.headerLookup)
      ? raw.headerLookup
          .filter((pair) => Array.isArray(pair) && pair.length >= 2)
          .map((pair) => [String(pair[0] || ""), Number(pair[1]) || 0])
      : entriesFromMapLike(raw.headerLookup).map(([k, v]) => [String(k || ""), Number(v) || 0])
  );
  if (!headerLookup.size && headerCells.length) {
    headerLookup = buildHeaderLookupIndex(headerCells);
  }
  return {
    sourceTextKey: String(raw.sourceTextKey || ""),
    headerCells,
    headerLookup,
    rowsByArticle,
  };
}

function buildSourceExportDataFromText(rawText) {
  const text = String(rawText || "");
  const parsed = parseSourceRowsClient(text, true);
  const rowsByArticle = new Map();
  for (const row of parsed.rows || []) {
    const articleId = String(row?.articleId || "").trim();
    if (!articleId) continue;
    const payload = {
      cells: Array.isArray(row.sourceCells) ? row.sourceCells.map((x) => String(x ?? "")) : [],
      named: row.sourceNamed && typeof row.sourceNamed === "object" ? row.sourceNamed : null,
    };
    rowsByArticle.set(articleId, payload);
    const shipment = String(row.shipmentSource || row.sourceNamed?.shipment || "").trim();
    if (shipment && !rowsByArticle.has(shipment)) rowsByArticle.set(shipment, payload);
  }
  return {
    sourceTextKey: text,
    headerCells: Array.isArray(parsed.headerCells) ? parsed.headerCells.map((x) => String(x ?? "")) : [],
    headerLookup: buildHeaderLookupIndex(parsed.headerCells || []),
    rowsByArticle,
  };
}

function rebuildActiveSourceExportData() {
  const text = getActiveSourceText();
  if (!text) {
    if (sourceState.mode === "file") sourceState.file.sourceExportData = null;
    else sourceState.textExportData = null;
    invalidateExportSourceDataCache();
    return null;
  }
  const exportData = buildSourceExportDataFromText(text);
  if (sourceState.mode === "file") sourceState.file.sourceExportData = exportData;
  else sourceState.textExportData = exportData;
  exportSourceDataMapKey = text;
  exportSourceDataMap = {
    rowsByArticle: exportData.rowsByArticle,
    headerLookup: exportData.headerLookup,
  };
  return exportData;
}

function getActiveSourceExportData() {
  const text = getActiveSourceText();
  const stored =
    sourceState.mode === "file" ? sourceState.file.sourceExportData : sourceState.textExportData;
  if (stored && stored.sourceTextKey === text && stored.rowsByArticle) {
    const shaped = ensureSourceExportDataShape(stored);
    if (shaped) {
      if (sourceState.mode === "file") sourceState.file.sourceExportData = shaped;
      else sourceState.textExportData = shaped;
      return shaped;
    }
  }
  return rebuildActiveSourceExportData();
}

function findSourceDataForRow(row, sourceMap) {
  if (!sourceMap || !row) return null;
  const keys = [
    row.articleId,
    row.fetchArticleId,
    row.shipment,
    row.sourceNamed?.shipment,
    row.sourceNamed?.articleId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (sourceMap.has(key)) return sourceMap.get(key);
  }
  return null;
}

function formatLayoutColumnHead(idx, slot) {
  const letter = excelColumnLetter(idx);
  const aliasPart = slot?.type === "source" && slot.label ? ` · ${slot.label}` : "";
  return `Колонка ${letter}${aliasPart}`;
}

function scheduleLayoutPreviewRefresh() {
  clearTimeout(layoutPreviewRefreshTimer);
  layoutPreviewRefreshTimer = setTimeout(() => {
    layoutPreviewRefreshTimer = null;
    void getJob().then((job) => {
      render(job);
    });
  }, 160);
}

function updateLayoutRowHeadLabel(colLabel, idx, slot) {
  if (!colLabel) return;
  colLabel.textContent = excelColumnLetter(idx);
  colLabel.title = formatLayoutColumnHead(idx, slot);
}

function normalizeHeaderLookupName(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildHeaderLookupIndex(headerCells) {
  const out = new Map();
  if (!Array.isArray(headerCells)) return out;
  for (let i = 0; i < headerCells.length; i++) {
    const key = normalizeHeaderLookupName(headerCells[i]);
    if (!key || out.has(key)) continue;
    out.set(key, i);
  }
  return out;
}

function getExportSourceDataByArticleId() {
  const exportData = getActiveSourceExportData();
  if (!exportData) return null;
  return {
    rowsByArticle: exportData.rowsByArticle,
    headerLookup: exportData.headerLookup,
  };
}

function isSourceColumnLikelyEmpty(srcIndex, sourceContext) {
  const rowsByArticle = sourceContext?.rowsByArticle;
  if (!rowsByArticle || typeof rowsByArticle.values !== "function") return false;
  const idx = Math.min(MAX_SRC_COL_INDEX, Math.max(0, Math.floor(Number(srcIndex)) || 0));
  let checked = 0;
  for (const row of rowsByArticle.values()) {
    const cells = Array.isArray(row?.cells) ? row.cells : [];
    const val = idx < cells.length ? String(cells[idx] ?? "").trim() : "";
    if (val) return false;
    checked += 1;
    if (checked >= 220) break;
  }
  return checked > 0;
}

function parseSourceRowsClient(rawText, includeSourceCells = false) {
  const fn = globalThis.__returnsParseSourceRows;
  if (typeof fn !== "function") {
    return { rows: [], totalNonEmptyLines: 0, missingIdRows: 0, headerSkipped: false, headerCells: [] };
  }
  return fn(rawText, includeSourceCells);
}

function parseSourceCellRowsClient(cellRows, includeSourceCells = false) {
  const fn = globalThis.__returnsParseSourceCellRows;
  if (typeof fn === "function") {
    return fn(cellRows, includeSourceCells);
  }
  // Fallback: serialize matrix to quoted CSV, then parse text.
  const lines = (Array.isArray(cellRows) ? cellRows : []).map((row) =>
    toCsvLine(Array.isArray(row) ? row : [])
  );
  return parseSourceRowsClient(lines.join("\n"), includeSourceCells);
}

function getActiveSourceVisibleCount() {
  if (sourceState.mode === "file" && sourceState.file.stats?.rows != null) {
    return Number(sourceState.file.stats.rows) || 0;
  }
  return parseSourceRowsClient(getActiveSourceText()).rows.length;
}

function buildSourceExportDataFromMergedMap(mergedById, headerCells, sourceTextKey) {
  const rowsByArticle = new Map();
  for (const row of mergedById.values()) {
    const articleId = String(row?.articleId || "").trim();
    if (!articleId) continue;
    const payload = {
      cells: Array.isArray(row.sourceCells) ? row.sourceCells.map((x) => String(x ?? "")) : [],
      named: {
        articleId,
        operationalWarehouse: String(row.operationalWarehouse || ""),
        shipment: String(row.shipmentSource || ""),
        postingType: String(row.postingType || ""),
      },
    };
    rowsByArticle.set(articleId, payload);
    const shipment = String(row.shipmentSource || "").trim();
    if (shipment && !rowsByArticle.has(shipment)) rowsByArticle.set(shipment, payload);
  }
  const normalizedHeader = Array.isArray(headerCells) ? headerCells.map((x) => String(x ?? "")) : [];
  return {
    sourceTextKey: String(sourceTextKey || ""),
    headerCells: normalizedHeader,
    headerLookup: buildHeaderLookupIndex(normalizedHeader),
    rowsByArticle,
  };
}

function updateFileSourceStats(rawText, opts = {}) {
  invalidateExportSourceDataCache();
  const st = parseSourceRowsClient(rawText);
  sourceState.file.stats = {
    rows: st.rows.length,
    missingIdRows: st.missingIdRows,
  };
  if (!opts.skipExportRebuild) rebuildActiveSourceExportData();
  return st;
}

async function persistSourceCache() {
  const cache = globalThis.__goodsAuditCache;
  if (!cache) return;
  // Пишем в IndexedDB только когда исходник реально поменялся: без этого каждое
  // изменение любой настройки заново сохраняло многомегабайтный текст.
  const fileNamesKey = normalizeFileNamesList(sourceState.file.fileNames).join("");
  const fileDirty =
    lastPersistedSource.fileText !== sourceState.file.text ||
    lastPersistedSource.fileName !== String(sourceState.file.fileName || "") ||
    lastPersistedSource.fileNamesKey !== fileNamesKey;
  if (fileDirty) {
    if (sourceState.file.text || sourceState.file.fileName) {
      let fileExport = null;
      try {
        fileExport = serializeSourceExportData(
          ensureSourceExportDataShape(sourceState.file.sourceExportData) ||
            sourceState.file.sourceExportData
        );
      } catch {
        fileExport = null;
      }
      await cache.saveSourceCache("file", {
        text: sourceState.file.text,
        fileName: sourceState.file.fileName,
        fileNames: normalizeFileNamesList(sourceState.file.fileNames),
        sourceExportData: fileExport,
      });
    } else {
      await cache.clearSourceCache("file");
    }
    lastPersistedSource.fileText = sourceState.file.text;
    lastPersistedSource.fileName = String(sourceState.file.fileName || "");
    lastPersistedSource.fileNamesKey = fileNamesKey;
  }
  const textDirty = lastPersistedSource.textInput !== sourceState.textInput;
  if (textDirty) {
    const text = String(sourceState.textInput || "").trim();
    if (text) {
      // Разобранные данные пишем только если они собраны именно для этого текста —
      // устаревший блоб от предыдущей версии текста не сохраняем.
      let textExport = null;
      try {
        const shaped = ensureSourceExportDataShape(sourceState.textExportData);
        const expectedKey = sourceState.mode === "text" ? getActiveSourceText() : null;
        if (shaped && expectedKey != null && shaped.sourceTextKey === expectedKey) {
          textExport = serializeSourceExportData(shaped);
        }
      } catch {
        textExport = null;
      }
      await cache.saveSourceCache("text", {
        text,
        fileName: "",
        sourceExportData: textExport,
      });
    } else {
      await cache.clearSourceCache("text");
    }
    lastPersistedSource.textInput = sourceState.textInput;
  }
}

async function restoreSourceFromCache() {
  const cache = globalThis.__goodsAuditCache;
  if (!cache) return;
  try {
    const fileEntry = await cache.loadSourceCache("file");
    if (fileEntry?.text) {
      sourceState.file.text = String(fileEntry.text);
      if (fileEntry.fileName) sourceState.file.fileName = String(fileEntry.fileName);
      sourceState.file.fileNames = normalizeFileNamesList(fileEntry.fileNames);
      sourceState.file.sourceExportData =
        ensureSourceExportDataShape(deserializeSourceExportData(fileEntry.sourceExportData)) ||
        null;
      updateFileSourceStats(sourceState.file.text, {
        skipExportRebuild: Boolean(sourceState.file.sourceExportData),
      });
      if (!sourceState.file.sourceExportData) rebuildActiveSourceExportData();
      lastPersistedSource.fileText = sourceState.file.text;
      lastPersistedSource.fileName = String(sourceState.file.fileName || "");
      lastPersistedSource.fileNamesKey = normalizeFileNamesList(sourceState.file.fileNames).join(
        ""
      );
    }
    const textEntry = await cache.loadSourceCache("text");
    if (textEntry?.text) {
      const restored = String(textEntry.text);
      modeWorkspaceState.text.textInput = restored;
      sourceState.textInput = restored;
      sourceState.textExportData =
        ensureSourceExportDataShape(deserializeSourceExportData(textEntry.sourceExportData)) ||
        null;
      if (!sourceState.textExportData) rebuildActiveSourceExportData();
      lastPersistedSource.textInput = sourceState.textInput;
    }
  } catch {
  }
}
const getActiveSourceName = () =>
  sourceState.mode === "file" ? sourceState.file.fileName || "" : "Ручной ввод";

function getJobProgressTotal(job) {
  if (!job) return 0;
  const toFetchRows = Number(job.inputStats?.toFetchRows);
  if (Number.isFinite(toFetchRows) && toFetchRows > 0) return toFetchRows;
  const planned = Number(job.plannedTotal);
  if (Number.isFinite(planned) && planned > 0) return planned;
  const fromCount = Number(job.toFetchCount);
  if (Number.isFinite(fromCount) && fromCount > 0) return fromCount;
  if (Array.isArray(job.toFetch) && job.toFetch.length > 0) return job.toFetch.length;
  const remaining = Number(job.inputStats?.remainingRows ?? job.remainingCount);
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  return 0;
}

function getJobProgressDone(job) {
  if (!job) return 0;
  const ok = Number(job.results?.length ?? job.resultsCount) || 0;
  const err = Number(job.errors?.length ?? job.errorsCount) || 0;
  const skippedOps =
    Number(job.skippedOpsWarehouse?.length ?? job.skippedOpsWarehouseCount) || 0;
  return ok + err + skippedOps;
}

function formatStatus(job) {
  if (!job) {
    return [
      "Как пользоваться:",
      "1. Выберите файл Excel или вставьте строки.",
      "2. Нажмите «Обработать» — откроется окно парсинга.",
      "3. Когда всё готово, скопируйте результат кнопками ниже.",
      "",
      "Пороги цен и колонки таблицы — в настройках (шестерёнка справа сверху).",
    ].join("\n");
  }
  const total = getJobProgressTotal(job);
  const ok = job.results?.length ?? job.resultsCount ?? 0;
  const err = job.errors?.length ?? job.errorsCount ?? 0;
  const skippedOps = Number(job.skippedOpsWarehouse?.length ?? job.skippedOpsWarehouseCount) || 0;
  const threshold = getEffectiveUpperThreshold();
  const minThreshold = getMinPriceThreshold();
  const fmt = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const t = fmt(threshold);
  const m = fmt(minThreshold);
  const lines = [];
  if (job.phase === "running") {
    lines.push(`Идёт обработка… ${ok}+${err} / ${total}`);
  } else if (job.phase === "paused") {
    lines.push(`Пауза. Успешно: ${ok}, ошибок: ${err}.`);
    if (job.stopReason) lines.push(`\n${String(job.stopReason)}`);
  } else if (job.phase === "aborted") {
    lines.push(`Остановлено. Успешно: ${ok}, ошибок: ${err}.`);
    if (job.stopReason) lines.push(`\n${String(job.stopReason)}`);
  } else {
    const bands = ensureRowBands(job);
    lines.push(`Готово. «Результат» в расширении.`);
    lines.push(`Успешно: ${ok}, ошибок: ${err}.`);
    let bandLine = `≥${t} ₽: ${bands.ge.length}, <${t} ₽: ${bands.lt.length}`;
    if (bands.below.length > 0) bandLine += `, <${m} ₽ пропущено: ${bands.below.length}`;
    if (skippedOps > 0) bandLine += `, пропущено: ${skippedOps}`;
    lines.push(bandLine);
  }
  const stats = job.inputStats;
  if (stats) {
    const nonEmpty = Number(stats.totalNonEmptyLines) || 0;
    const withId = Number(stats.sourceVisibleCount) || 0;
    const noId = Number(stats.missingIdRows) || 0;
    const dup = Number(stats.duplicateRows) || 0;
    const mem = Number(stats.skippedMemRows) || 0;
    const typeSkip = Number(stats.skippedTypeRows) || 0;
    const plan = Number(stats.toFetchRows) || total;
    lines.push(
      `\nСтроки: непустых ${nonEmpty}, с ID ${withId}, без ID ${noId}, дубли ${dup}, уже в памяти ${mem}` +
        (typeSkip > 0 ? `, неподдерживаемый тип ${typeSkip}` : "") +
        `, к обработке ${plan}.`
    );
  }
  if (job.sourceName) lines.push(`\nФайл: ${job.sourceName}`);
  if (job.phase === "done" || job.phase === "aborted") {
    if (job.errors?.length) {
      const shown = job.errors.slice(0, MAX_STATUS_DETAIL_LINES);
      lines.push("\nОшибки:\n" + shown.map((e) => `${e.articleId}: ${e.message}`).join("\n"));
      const extra = (job.errorsTruncated || 0) + Math.max(0, job.errors.length - shown.length);
      if (extra > 0) lines.push(`\n…ещё ${extra} ошибок`);
    }
  }
  return lines.join("") || "—";
}

function refreshThresholdDependentLabels() {
  const threshold = getEffectiveUpperThreshold();
  const minThreshold = getMinPriceThreshold();
  const fmt = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const t = fmt(threshold);
  const m = fmt(minThreshold);
  const tip =
    `Делит результат на «${t} ≥» и «${m}…<${t}». ` +
    `В первую попадают цены от ${t} ₽, во вторую — от ${m} до ${t} ₽. ` +
    `Дешевле ${m} ₽ строки не копируются.`;
  const priceHelp = $("priceThresholdField")?.querySelector(".field-help");
  if (priceHelp) priceHelp.setAttribute("data-tip", tip);
  const geTitle = $("layoutGeTitle");
  const ltTitle = $("layoutLtTitle");
  if (geTitle) geTitle.textContent = `Колонки: ${t} ≥`;
  if (ltTitle) ltTitle.textContent = `Колонки: ${m}…<${t}`;
  const capGe = $("previewGeCaption");
  const capLt = $("previewLtCaption");
  const capVulnerable = $("previewVulnerableCaption");
  if (capGe) capGe.textContent = `${t} ≥ — предпросмотр`;
  if (capLt) capLt.textContent = `${m}…<${t} — предпросмотр`;
  if (capVulnerable) {
    const vulnerableMin = getVulnerableMinPriceThreshold();
    const vf = String(Number(vulnerableMin) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    capVulnerable.textContent =
      vulnerableMin > 0
        ? `Товары группы риска от ${vf} ₽ — предпросмотр`
        : "Товары группы риска — предпросмотр";
  }
}

function refreshCopyButtonsText() {
  const threshold = getEffectiveUpperThreshold();
  const minThreshold = getMinPriceThreshold();
  const fmt = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const t = fmt(threshold);
  const m = fmt(minThreshold);
  copyButtonLabels.ge10k = `Копировать ${t} ≥`;
  copyButtonLabels.lt10k = `Копировать ${m}…<${t}`;
  if ($("copyGt10k") && !$("copyGt10k").classList.contains("btn-copied")) {
    $("copyGt10k").textContent = copyButtonLabels.ge10k;
  }
  if ($("copyLt10k") && !$("copyLt10k").classList.contains("btn-copied")) {
    $("copyLt10k").textContent = copyButtonLabels.lt10k;
  }
  if ($("copyVulnerable") && !$("copyVulnerable").classList.contains("btn-copied")) {
    $("copyVulnerable").textContent = copyButtonLabels.vulnerable;
  }
  if ($("copyAllRows") && !$("copyAllRows").classList.contains("btn-copied")) {
    $("copyAllRows").textContent = copyButtonLabels.allRows;
  }
  if ($("copyJobErrors") && !$("copyJobErrors").classList.contains("btn-copied")) {
    $("copyJobErrors").textContent = copyButtonLabels.errors;
  }
  refreshThresholdDependentLabels();
}

function render(jobRaw) {
  refreshCopyButtonsText();
  const activeMode = getActiveModeKey();
  if (clearedJobModes.has(activeMode)) {
    const incomingPhase = jobRaw?.phase;
    if (incomingPhase === "running" || incomingPhase === "paused") {
      clearedJobModes.delete(activeMode);
    } else {
      modeLastJobState[activeMode] = null;
      lastJobState = null;
      jobRaw = null;
    }
  }
  const jobMode =
    jobRaw?.sourceMode === "text" ? "text" : jobRaw?.sourceMode === "file" ? "file" : "";
  if (jobMode) {
    modeLastJobState[jobMode] = jobRaw || null;
  }
  const job = jobRaw && jobMode === activeMode ? jobRaw : modeLastJobState[activeMode];
  lastJobState = job || null;
  const hasActiveData =
    activeMode === "file"
      ? Boolean(sourceState.file?.text || sourceState.file?.fileName)
      : Boolean(String(sourceState.textInput || "").trim());
  if ($("clearSource")) $("clearSource").disabled = !hasActiveData;
  const jobPayloadCount =
    (job?.results?.length || 0) +
    (job?.errors?.length || 0) +
    (job?.toFetch?.length || job?.inputStats?.toFetchRows || 0) +
    (job?.skippedMem?.length || 0) +
    (job?.skippedDupSource?.length || 0);
  const canClearJob =
    job && job.phase !== "running" && job.phase !== "paused" && jobPayloadCount > 0;
  if ($("clearJob")) $("clearJob").disabled = !canClearJob;
  const running = job?.phase === "running";
  const paused = job?.phase === "paused";
  const finished = job?.phase === "done" || job?.phase === "aborted";
  $("run").disabled = running || paused || !getActiveSourceText();
  $("pause").disabled = runControlBusy || !(running || paused);
  $("pause").textContent = paused ? "Продолжить" : "Пауза";
  $("stop").disabled = runControlBusy || !(running || paused);

  $("run").classList.toggle(
    "is-ready",
    !job && !running && !paused && Boolean(getActiveSourceText())
  );

  if (!job) {
    previewRequestDateCache = { key: "", value: "" };
    resetJobProgressUi({ show: false });
    $("status").textContent = formatStatus(null);
    $("previewGe").textContent = "";
    $("previewLt").textContent = "";
    if ($("previewVulnerable")) $("previewVulnerable").textContent = "";
    if ($("copyVulnerable")) $("copyVulnerable").disabled = true;
    if ($("copyAllRows")) $("copyAllRows").disabled = true;
    if ($("copyJobErrors")) $("copyJobErrors").disabled = true;
    $("copyGt10k").disabled = true;
    $("copyLt10k").disabled = true;
    return;
  }

  const errCount = job?.errors?.length || Number(job?.errorsCount) || 0;
  if ($("copyJobErrors")) $("copyJobErrors").disabled = running || errCount === 0;

  const total = getJobProgressTotal(job);
  const doneCount = getJobProgressDone(job);
  const showProgress = running || paused || (finished && total > 0);
  $("progressWrap").classList.add("is-slot-reserved");
  $("progressWrap").hidden = !showProgress;
  const pct = total
    ? job.phase === "done"
      ? 100
      : doneCount >= total
        ? 100
        : Math.min(99, Math.round((doneCount / total) * 100))
    : 0;
  const fill = $("progressFill");
  if (fill) {
    if (!showProgress) {
      resetJobProgressUi({ show: false });
    } else {
      const prev = Number.parseFloat(String(fill.style.width || "0")) || 0;
      if (running || paused) fill.classList.add("is-live");
      else fill.classList.remove("is-live");
      if (pct < prev - 0.5) {
        fill.style.transition = "none";
        fill.style.width = `${pct}%`;
        void fill.offsetWidth;
        fill.style.transition = "";
      } else {
        fill.style.width = `${pct}%`;
      }
    }
  }
  if (showProgress) {
    const pctLabel = total ? `${pct}%` : "";
    let progressMain;
    if (job.phase === "done") progressMain = "Готово";
    else if (job.phase === "aborted") progressMain = "Остановлено";
    else if (paused) progressMain = "Пауза";
    else if (running) progressMain = job.currentArticleId ? `ID ${job.currentArticleId}` : "Обработка…";
    else progressMain = "Ожидание";
    if (pctLabel) progressMain = `${progressMain} | ${pctLabel}`;
    $("progressLabel").textContent = progressMain;
    $("progressCounts").textContent = total ? `${Math.min(doneCount, total)} / ${total}` : "";
  }
  $("status").textContent = formatStatus(job);

  if (running) {
    $("copyGt10k").disabled = true;
    $("copyLt10k").disabled = true;
    if ($("copyVulnerable")) $("copyVulnerable").disabled = true;
    if ($("copyAllRows")) $("copyAllRows").disabled = true;
    if (!$("previewGe").dataset.deferred) {
      $("previewGe").textContent = "Предпросмотр обновится после завершения…";
      $("previewGe").dataset.deferred = "1";
    }
    if (!$("previewLt").dataset.deferred) {
      $("previewLt").textContent = "Предпросмотр обновится после завершения…";
      $("previewLt").dataset.deferred = "1";
    }
    if ($("previewVulnerable") && !$("previewVulnerable").dataset.deferred) {
      $("previewVulnerable").textContent = "Предпросмотр обновится после завершения…";
      $("previewVulnerable").dataset.deferred = "1";
    }
  } else {
    const bands = ensureRowBands(job);
    $("copyGt10k").disabled = bands.ge.length === 0;
    $("copyLt10k").disabled = bands.lt.length === 0;
    if ($("copyVulnerable")) $("copyVulnerable").disabled = bands.vulnerable.length === 0;
    if ($("copyAllRows")) $("copyAllRows").disabled = bands.all.length === 0;
    const th = getEffectiveUpperThreshold();
    const minTh = getMinPriceThreshold();
    const tf = String(Number(th) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    const mf = String(Number(minTh) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    const hasResults = bands.all.length > 0 || (Number(job.resultsCount) || 0) > 0;
    const previewDate = getPreviewRequestDateStr(job);
    setPreviewTextIfChanged(
      $("previewGe"),
      buildPreviewTsv(bands.ge, "ge10k", previewDate) ||
        (hasResults ? `(нет строк ≥ ${tf} ₽)` : "(пусто)")
    );
    setPreviewTextIfChanged(
      $("previewLt"),
      buildPreviewTsv(bands.lt, "lt10k", previewDate) ||
        (hasResults ? `(нет строк от ${mf} до ${tf} ₽)` : "(пусто)")
    );
    if ($("previewVulnerable")) {
      setPreviewTextIfChanged(
        $("previewVulnerable"),
        buildPreviewTsv(bands.vulnerable, "ge10k", previewDate) ||
          (hasResults ? "(нет уязвимых товаров)" : "(пусто)")
      );
    }
    delete $("previewGe").dataset.deferred;
    delete $("previewLt").dataset.deferred;
    if ($("previewVulnerable")) delete $("previewVulnerable").dataset.deferred;
  }
  startJobPollIfNeeded(job);
}

async function refresh(opts = {}) {
  const restoreScroll = opts.restoreLayoutScroll === true;
  const panel = $("panelSettings");
  const onLayoutTab =
    panel && !panel.hidden && getSettingsActiveTab() === "layout";
  const snap =
    restoreScroll && onLayoutTab ? captureLayoutEditorScrollAnchor() : null;
  render(await getJob());
  if (snap) applyLayoutEditorScrollAnchor(snap);
}

function refreshRunButtonOnly() {
  const running = lastJobState?.phase === "running";
  const paused = lastJobState?.phase === "paused";
  const hasSource = Boolean(getActiveSourceText());
  $("run").disabled = running || paused || !hasSource;
  $("run").classList.toggle("is-ready", !lastJobState && !running && !paused && hasSource);
}

function showSettingsPanel(open, opts = {}) {
  $("workArea").hidden = Boolean(open);
  $("panelSettings").hidden = !open;
  const gear = $("btnOpenSettings");
  gear.setAttribute("aria-expanded", open ? "true" : "false");
  gear.classList.toggle("is-active", Boolean(open));
  if (open) {
    applyOutputPrefsToUi({ rebuildLayout: false, rebuildLists: true });
    if (getSettingsActiveTab() === "layout" && !layoutPanelsBuilt()) {
      setSettingsTab("layout", { skipSave: true, forceRebuild: true });
    }
  }
  if (!opts.skipSave) savePopupPrefs();
}

const LAYOUT_PREF_KEYS = {
  layoutGeGrid: "layoutGe",
  layoutLtGrid: "layoutLt",
};

function getSettingsLayoutScrollEl() {
  return $("settingsLayoutScroll");
}

let layoutDragAutoScrollRaf = 0;
let layoutDragAutoScrollDir = 0;
let layoutDragActive = false;

function stopLayoutDragAutoScroll() {
  layoutDragActive = false;
  layoutDragAutoScrollDir = 0;
  if (layoutDragAutoScrollRaf) {
    cancelAnimationFrame(layoutDragAutoScrollRaf);
    layoutDragAutoScrollRaf = 0;
  }
}

function tickLayoutDragAutoScroll() {
  layoutDragAutoScrollRaf = 0;
  if (!layoutDragActive || !layoutDragAutoScrollDir) return;
  const scrollEl = getSettingsLayoutScrollEl();
  if (!scrollEl) {
    stopLayoutDragAutoScroll();
    return;
  }
  const speed = layoutDragAutoScrollDir;
  const prev = scrollEl.scrollTop;
  const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, prev + speed));
  if (scrollEl.scrollTop === prev && speed !== 0) {
    const doc = document.scrollingElement || document.documentElement;
    doc.scrollTop += speed;
  }
  layoutDragAutoScrollRaf = requestAnimationFrame(tickLayoutDragAutoScroll);
}

function updateLayoutDragAutoScroll(clientY) {
  const scrollEl = getSettingsLayoutScrollEl();
  if (!scrollEl || !Number.isFinite(clientY)) {
    layoutDragAutoScrollDir = 0;
    return;
  }
  const rect = scrollEl.getBoundingClientRect();
  const edge = Math.max(72, Math.round(rect.height * 0.28));
  let dir = 0;
  let intensity = 0;
  if (clientY < rect.top + edge) {
    dir = -1;
    intensity = (rect.top + edge - clientY) / edge;
  } else if (clientY > rect.bottom - edge) {
    dir = 1;
    intensity = (clientY - (rect.bottom - edge)) / edge;
  }
  if (!dir) {
    if (clientY < rect.top) {
      dir = -1;
      intensity = 1.4;
    } else if (clientY > rect.bottom) {
      dir = 1;
      intensity = 1.4;
    }
  }
  const speed = dir ? Math.max(8, Math.round(10 + intensity * 22)) * dir : 0;
  layoutDragAutoScrollDir = speed;
  if (speed && !layoutDragAutoScrollRaf) {
    layoutDragAutoScrollRaf = requestAnimationFrame(tickLayoutDragAutoScroll);
  }
}

function captureLayoutEditorScrollAnchor() {
  const doc = document.scrollingElement || document.documentElement;
  const inner = getSettingsLayoutScrollEl();
  return {
    doc: doc.scrollTop,
    inner: inner ? inner.scrollTop : 0,
  };
}

function applyLayoutEditorScrollAnchor(snap) {
  if (!snap) return;
  const doc = document.scrollingElement || document.documentElement;
  const inner = getSettingsLayoutScrollEl();
  doc.scrollTop = snap.doc;
  if (inner) inner.scrollTop = snap.inner;
}

function fillMappingSelect(select, slot) {
  select.replaceChildren();
  const ogF = document.createElement("optgroup");
  ogF.label = "Поля";
  OUTPUT_FIELDS.forEach((field) => {
    const opt = document.createElement("option");
    opt.value = `f:${field.id}`;
    opt.textContent = field.label;
    ogF.append(opt);
  });
  const ogS = document.createElement("optgroup");
  ogS.label = "Столбец исходника (как в Excel)";
  for (let i = 0; i <= MAX_SRC_COL_INDEX; i++) {
    const opt = document.createElement("option");
    opt.value = `src:${i}`;
    opt.textContent = excelColumnLetter(i);
    ogS.append(opt);
  }
  select.append(ogF, ogS);
  select.value = slotToSelectValue(slot);
}

function createLayoutRow(containerId, prefKey, slot, idx) {
  const row = document.createElement("div");
  row.className = "layout-constructor-row";
  row.dataset.idx = String(idx);
  row.draggable = true;
  row.title = "Перетащите, чтобы поменять колонки местами";

  row.addEventListener("dragstart", (e) => {
    const t = e.target;
    if (
      t &&
      typeof t.closest === "function" &&
      t.closest("select, input, button, textarea, a")
    ) {
      e.preventDefault();
      return;
    }
    row.classList.add("is-dragging");
    layoutDragActive = true;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.setData(
      "application/x-goodsaudit-layout",
      JSON.stringify({ containerId, prefKey, from: idx })
    );
  });
  row.addEventListener("dragend", () => {
    stopLayoutDragAutoScroll();
    row.classList.remove("is-dragging");
    const root = $(containerId);
    if (root) {
      root.querySelectorAll(".layout-constructor-row.is-drag-over").forEach((el) => {
        el.classList.remove("is-drag-over");
      });
    }
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("is-drag-over");
    if (layoutDragActive) updateLayoutDragAutoScroll(e.clientY);
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("is-drag-over");
  });
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    stopLayoutDragAutoScroll();
    row.classList.remove("is-drag-over");
    let from = Number(e.dataTransfer.getData("text/plain"));
    try {
      const meta = JSON.parse(e.dataTransfer.getData("application/x-goodsaudit-layout") || "{}");
      if (meta?.containerId && meta.containerId !== containerId) return;
      if (Number.isFinite(Number(meta?.from))) from = Number(meta.from);
    } catch {
    }
    const to = Number(row.dataset.idx);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
    const list = outputPrefs[prefKey];
    if (!Array.isArray(list) || from < 0 || from >= list.length || to < 0 || to >= list.length) {
      return;
    }
    const tmp = list[from];
    list[from] = list[to];
    list[to] = tmp;
    rebuildLayoutPanel(containerId);
    await savePopupPrefs();
    await refresh();
  });

  const dragHandle = document.createElement("span");
  dragHandle.className = "layout-drag-handle";
  dragHandle.setAttribute("aria-hidden", "true");
  dragHandle.textContent = "⋮⋮";
  const colLabel = document.createElement("span");
  colLabel.className = "layout-out-col";
  updateLayoutRowHeadLabel(colLabel, idx, slot);

  const rm = createDeleteButton({ ariaLabel: "Удалить колонку", small: true });
  rm.addEventListener("click", async () => {
    if (outputPrefs[prefKey].length === 0) return;
    const letter = excelColumnLetter(idx);
    if (!(await askAppConfirm(`Удалить колонку ${letter}?`, "Удаление колонки"))) return;
    pushLayoutDeletion(prefKey, idx, outputPrefs[prefKey][idx]);
    outputPrefs[prefKey].splice(idx, 1);
    rebuildLayoutPanel(containerId);
    await savePopupPrefs();
    await refresh();
  });

  const select = document.createElement("select");
  select.className = "select-oz layout-mapping-select";
  fillMappingSelect(select, slot);
  select.addEventListener("change", async () => {
    let aliasVal = (row.querySelector(".layout-src-alias")?.value || "").trim();
    const next = parseSelectValue(select.value);
    if (next.type === "source") {
      if (!aliasVal) {
        const asked = await askAppInput({
          title: "Оповещение расширения GoodsAudit",
          message:
            `Для колонки ${excelColumnLetter(idx)} можно задать название столбца из исходника (опционально).\n` +
            "Если оставить пустым, берём строго по букве.",
          value: "",
          placeholder: "",
          okText: "ОК",
          cancelText: "Отмена",
        });
        aliasVal = String(asked || "").trim();
      }
      next.label = aliasVal;
      if (!next.label) {
        const sourceContext = getExportSourceDataByArticleId();
        if (isSourceColumnLikelyEmpty(next.srcIndex, sourceContext)) {
          outputPrefs[prefKey][idx] = { type: "field", fieldId: "empty" };
          showAppToast(
            `Колонка ${excelColumnLetter(next.srcIndex)} пустая. Слот ${excelColumnLetter(idx)} переключён в «(пусто)».`,
            3200
          );
          rebuildLayoutPanel(containerId);
          await savePopupPrefs();
          await refresh();
          return;
        }
      }
    }
    outputPrefs[prefKey][idx] = next;
    rebuildLayoutPanel(containerId);
    await savePopupPrefs();
    await refresh();
  });

  const aliasInput = document.createElement("input");
  aliasInput.type = "text";
  aliasInput.className = "layout-src-alias";
  aliasInput.placeholder = "заголовок столбца";
  aliasInput.title = "Название столбца в исходнике (необязательно)";
  aliasInput.value = slot.type === "source" ? slot.label || "" : "";
  aliasInput.style.display = slot.type === "source" ? "" : "none";
  aliasInput.addEventListener("input", () => {
    const i = Number(row.dataset.idx);
    if (outputPrefs[prefKey][i]?.type === "source") {
      outputPrefs[prefKey][i].label = String(aliasInput.value || "").trim();
      updateLayoutRowHeadLabel(colLabel, i, outputPrefs[prefKey][i]);
    }
    scheduleLayoutPreviewRefresh();
  });
  aliasInput.addEventListener("blur", async () => {
    await savePopupPrefs();
  });

  row.classList.toggle("has-alias", slot.type === "source");
  row.append(dragHandle, colLabel, select, aliasInput, rm);
  select.draggable = false;
  aliasInput.draggable = false;
  rm.draggable = false;
  return row;
}

function rebuildLayoutPanel(containerId, opts = {}) {
  const prefKey = LAYOUT_PREF_KEYS[containerId];
  if (!prefKey) return;
  const fallbackIds = prefKey === "layoutLt" ? DEFAULT_LAYOUT_LT : DEFAULT_LAYOUT_GE;
  outputPrefs[prefKey] = clampSlotsLength(
    migrateLayoutToSlots(outputPrefs[prefKey], fallbackIds),
    fallbackIds
  );
  const root = $(containerId);
  if (!root) return;
  const scrollEl = getSettingsLayoutScrollEl();
  const keepScroll =
    !opts.skipScrollPreserve &&
    scrollEl &&
    $("panelSettings") &&
    !$("panelSettings").hidden &&
    getSettingsActiveTab() === "layout";
  const prevScroll = keepScroll ? scrollEl.scrollTop : 0;
  const ae = document.activeElement;
  if (ae && typeof root.contains === "function" && root.contains(ae)) {
    ae.blur();
  }
  root.replaceChildren();
  outputPrefs[prefKey].forEach((slot, idx) => {
    root.append(createLayoutRow(containerId, prefKey, slot, idx));
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary btn-sm layout-add-col";
  addBtn.textContent = "+ Колонка";
  addBtn.disabled = outputPrefs[prefKey].length >= LAYOUT_SLOT_MAX;
  addBtn.addEventListener("click", async () => {
    if (outputPrefs[prefKey].length >= LAYOUT_SLOT_MAX) return;
    outputPrefs[prefKey].push({ type: "field", fieldId: "empty" });
    rebuildLayoutPanel(containerId);
    await savePopupPrefs();
    render(await getJob());
  });
  root.append(addBtn);
  if (keepScroll && scrollEl) scrollEl.scrollTop = prevScroll;
}

function applyUiGradientToDom() {
  const on = outputPrefs.uiGradient !== false;
  document.body.classList.toggle("ui-gradient", on);
  const toggle = $("uiGradientToggle");
  if (toggle) toggle.checked = on;
}

function applyAggressiveModeToDom() {
  const toggle = $("aggressiveModeToggle");
  if (!toggle) return;
  const on = outputPrefs.aggressiveMode === true;
  if (toggle.checked !== on) toggle.checked = on;
}

function applyExcludeMemoryIdsToDom() {
  const toggle = $("excludeMemoryIdsToggle");
  if (!toggle) return;
  const on = outputPrefs.excludeMemoryIds === true;
  if (toggle.checked !== on) toggle.checked = on;
}

function applyHyperlinksToDom() {
  const on = areHyperlinksEnabled();
  const toggle = $("hyperlinksToggle");
  if (toggle) toggle.checked = on;
  const wrap = $("hyperlinkServicesWrap");
  if (wrap) wrap.hidden = !on;
  const articleSelect = $("hyperlinkServiceArticleId");
  if (articleSelect) {
    articleSelect.value = normalizeHyperlinkService(outputPrefs.hyperlinkServiceArticleId);
  }
  const shipmentSelect = $("hyperlinkServiceShipment");
  if (shipmentSelect) {
    shipmentSelect.value = normalizeHyperlinkService(outputPrefs.hyperlinkServiceShipment);
  }
}

function applyOutputPrefsToUi(opts = {}) {
  const rebuildLayout = opts.rebuildLayout === true;
  const rebuildLists = opts.rebuildLists !== false;
  if ($("priceThreshold")) $("priceThreshold").value = String(getPriceThreshold());
  if ($("minPriceThreshold")) $("minPriceThreshold").value = String(getMinPriceThreshold());
  if ($("vulnerableMinPriceThreshold")) {
    $("vulnerableMinPriceThreshold").value = String(getVulnerableMinPriceThreshold());
  }
  applyThreadsChoiceToDom();
  applyUiGradientToDom();
  applyAggressiveModeToDom();
  applyExcludeMemoryIdsToDom();
  applyHyperlinksToDom();
  refreshThresholdDependentLabels();
  const settingsOpen = $("panelSettings") && !$("panelSettings").hidden;
  const onLayoutTab = settingsOpen && getSettingsActiveTab() === "layout";
  if (rebuildLayout && onLayoutTab) {
    const snap = captureLayoutEditorScrollAnchor();
    rebuildLayoutPanel("layoutGeGrid", { skipScrollPreserve: true });
    rebuildLayoutPanel("layoutLtGrid", { skipScrollPreserve: true });
    if (snap) applyLayoutEditorScrollAnchor(snap);
  }
  if (settingsOpen && rebuildLists) {
    renderOpsWarehousesList();
    renderVulnerabilityKeywordsList();
  }
}

function cloneLayoutForPrefs(arr) {
  try {
    return JSON.parse(JSON.stringify(Array.isArray(arr) ? arr : []));
  } catch {
    return Array.isArray(arr) ? arr.map((x) => ({ ...normalizeLayoutSlot(x) })) : [];
  }
}

function buildTableColumnsExportPayload() {
  return {
    kind: TABLE_COLUMNS_EXPORT_KIND,
    version: TABLE_COLUMNS_EXPORT_VERSION,
    schemaVersion: LAYOUT_PREFS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    layoutGe: cloneLayoutForPrefs(outputPrefs.layoutGe),
    layoutLt: cloneLayoutForPrefs(outputPrefs.layoutLt),
  };
}

function parseTableColumnsImportPayload(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Файл не содержит настройки колонок." };
  }
  if (raw.kind && raw.kind !== TABLE_COLUMNS_EXPORT_KIND) {
    return { ok: false, error: "Неизвестный тип файла настроек." };
  }
  if (!Array.isArray(raw.layoutGe) || !Array.isArray(raw.layoutLt)) {
    return { ok: false, error: "В файле должны быть массивы layoutGe и layoutLt." };
  }
  return { ok: true, layoutGe: raw.layoutGe, layoutLt: raw.layoutLt };
}

function applyImportedTableColumns({ layoutGe, layoutLt }) {
  outputPrefs.layoutGe = clampSlotsLength(migrateLayoutToSlots(layoutGe, DEFAULT_LAYOUT_GE), DEFAULT_LAYOUT_GE);
  outputPrefs.layoutLt = clampSlotsLength(migrateLayoutToSlots(layoutLt, DEFAULT_LAYOUT_LT), DEFAULT_LAYOUT_LT);
  applyOutputPrefsToUi({ rebuildLayout: true, rebuildLists: true });
  refreshCopyButtonsText();
  void refresh();
}

function exportTableColumnsToFile() {
  const payload = buildTableColumnsExportPayload();
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `goodsaudit-table-columns-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showAppToast("Колонки таблицы экспортированы.", 2800);
}

async function importTableColumnsFromFile(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showAppToast("Не удалось прочитать файл. Нужен JSON.", 3200);
    return;
  }
  const result = parseTableColumnsImportPayload(parsed);
  if (!result.ok) {
    showAppToast(result.error || "Неверный формат файла.", 3200);
    return;
  }
  const confirmed = await askAppConfirm(
    "Импорт заменит текущие колонки таблицы (≥ и <). Продолжить?",
    "Импорт колонок таблицы"
  );
  if (!confirmed) return;
  applyImportedTableColumns(result);
  await savePopupPrefs();
  await refresh();
  showAppToast("Колонки таблицы импортированы.", 2800);
}

const SETTINGS_PRESETS_KEY = "goodsAuditSettingsPresetsV1";
const SETTINGS_PRESETS_MAX = 20;
const PRESET_NAME_MAX_LEN = 40;

function normalizePresetName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, PRESET_NAME_MAX_LEN);
}

function normalizeSettingsPreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = normalizePresetName(raw.name);
  if (!name) return null;
  const id =
    typeof raw.id === "string" && raw.id
      ? raw.id
      : typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `p${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  return {
    id,
    name,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    data,
  };
}

async function loadSettingsPresets() {
  try {
    const { [SETTINGS_PRESETS_KEY]: arr } = await chrome.storage.local.get(SETTINGS_PRESETS_KEY);
    settingsPresets = (Array.isArray(arr) ? arr : [])
      .map((x) => normalizeSettingsPreset(x))
      .filter(Boolean);
  } catch {
    settingsPresets = [];
  }
  return settingsPresets;
}

async function saveSettingsPresets() {
  await chrome.storage.local.set({ [SETTINGS_PRESETS_KEY]: settingsPresets });
}

function buildPresetDataFromCurrent() {
  return {
    priceThreshold: getPriceThreshold(),
    minPriceThreshold: getMinPriceThreshold(),
    vulnerableMinPriceThreshold: getVulnerableMinPriceThreshold(),
    layoutGe: cloneLayoutForPrefs(outputPrefs.layoutGe),
    layoutLt: cloneLayoutForPrefs(outputPrefs.layoutLt),
    opsWarehouses: getOpsWarehousesList(),
    threadsChoice: normalizeThreadsChoice(outputPrefs.threadsChoice),
    excludeMemoryIds: outputPrefs.excludeMemoryIds === true,
    aggressiveMode: outputPrefs.aggressiveMode === true,
    hyperlinksEnabled: areHyperlinksEnabled(),
    hyperlinkServiceArticleId: normalizeHyperlinkService(outputPrefs.hyperlinkServiceArticleId),
    hyperlinkServiceShipment: normalizeHyperlinkService(outputPrefs.hyperlinkServiceShipment),
  };
}

function getSelectedPreset() {
  if (!selectedPresetId) return null;
  return settingsPresets.find((p) => p.id === selectedPresetId) || null;
}

function renderPresetSelect() {
  const select = $("presetSelect");
  if (!select) return;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = settingsPresets.length
    ? "— выберите пресет —"
    : "Пресетов пока нет";
  select.append(placeholder);
  for (const preset of settingsPresets) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.name;
    select.append(opt);
  }
  if (selectedPresetId && settingsPresets.some((p) => p.id === selectedPresetId)) {
    select.value = selectedPresetId;
  } else {
    selectedPresetId = "";
    select.value = "";
  }
  const hasSelection = Boolean(getSelectedPreset());
  if ($("btnApplyPreset")) $("btnApplyPreset").disabled = !hasSelection;
  if ($("btnUpdatePreset")) $("btnUpdatePreset").disabled = !hasSelection;
  if ($("btnDeletePreset")) $("btnDeletePreset").disabled = !hasSelection;
  select.disabled = settingsPresets.length === 0;
}

async function applySettingsPreset(preset) {
  const d = preset?.data && typeof preset.data === "object" ? preset.data : {};
  const parsedUpper = Number(d.priceThreshold);
  outputPrefs.priceThreshold =
    Number.isFinite(parsedUpper) && parsedUpper >= 0 ? parsedUpper : DEFAULT_PRICE_THRESHOLD;
  outputPrefs.minPriceThreshold = Math.max(0, Number(d.minPriceThreshold) || 0);
  outputPrefs.vulnerableMinPriceThreshold = Math.max(
    0,
    Number(d.vulnerableMinPriceThreshold) || 0
  );
  outputPrefs.layoutGe = clampSlotsLength(
    migrateLayoutToSlots(d.layoutGe, DEFAULT_LAYOUT_GE),
    DEFAULT_LAYOUT_GE
  );
  outputPrefs.layoutLt = clampSlotsLength(
    migrateLayoutToSlots(d.layoutLt, DEFAULT_LAYOUT_LT),
    DEFAULT_LAYOUT_LT
  );
  outputPrefs.opsWarehouses = Array.isArray(d.opsWarehouses)
    ? d.opsWarehouses.map((x) => String(x ?? ""))
    : [];
  if (!outputPrefs.opsWarehouses.length) outputPrefs.opsWarehouses = [""];
  outputPrefs.threadsChoice = normalizeThreadsChoice(d.threadsChoice);
  if (outputPrefs.threadsChoice !== "auto") {
    outputPrefs.lastManualThreads = Number(outputPrefs.threadsChoice);
  }
  outputPrefs.excludeMemoryIds = d.excludeMemoryIds === true;
  outputPrefs.hyperlinksEnabled = d.hyperlinksEnabled !== false;
  outputPrefs.hyperlinkServiceArticleId = normalizeHyperlinkService(d.hyperlinkServiceArticleId);
  outputPrefs.hyperlinkServiceShipment = normalizeHyperlinkService(d.hyperlinkServiceShipment);
  const nextAggressive = d.aggressiveMode === true;
  const aggressiveChanged = outputPrefs.aggressiveMode !== nextAggressive;
  outputPrefs.aggressiveMode = nextAggressive;
  rowBandCache = { key: "", ge: [], lt: [], below: [], vulnerable: [], all: [] };
  applyOutputPrefsToUi({ rebuildLayout: true, rebuildLists: true });
  refreshCopyButtonsText();
  if (aggressiveChanged) {
    try {
      await chrome.runtime.sendMessage({
        type: "UPDATE_AGGRESSIVE_MODE",
        sourceMode: getActiveModeKey(),
        aggressiveMode: nextAggressive,
      });
    } catch {
    }
  }
  await savePopupPrefs();
  await refresh();
}

async function onSavePresetClick() {
  if (settingsPresets.length >= SETTINGS_PRESETS_MAX) {
    showAppToast(`Достигнут лимит пресетов (${SETTINGS_PRESETS_MAX}). Удалите ненужный.`, 4200);
    return;
  }
  const name = await askAppInput({
    title: "Новый пресет",
    message: "Название пресета — например: «Основной склад» или «Инвентаризация».",
    placeholder: "Название пресета",
    okText: "Сохранить",
    cancelText: "Отмена",
  });
  if (name == null) return;
  const cleanName = normalizePresetName(name);
  if (!cleanName) {
    showAppToast("Название пресета не может быть пустым.", 3200);
    return;
  }
  const now = Date.now();
  const preset = normalizeSettingsPreset({
    name: cleanName,
    createdAt: now,
    updatedAt: now,
    data: buildPresetDataFromCurrent(),
  });
  if (!preset) return;
  settingsPresets.push(preset);
  selectedPresetId = preset.id;
  renderPresetSelect();
  await saveSettingsPresets();
  await savePopupPrefs();
  showAppToast(`Пресет «${preset.name}» сохранён.`, 2800);
}

async function onUpdatePresetClick() {
  const preset = getSelectedPreset();
  if (!preset) return;
  const ok = await askAppConfirm(
    `Перезаписать пресет «${preset.name}» текущими настройками?`,
    "Обновление пресета"
  );
  if (!ok) return;
  preset.data = buildPresetDataFromCurrent();
  preset.updatedAt = Date.now();
  await saveSettingsPresets();
  showAppToast(`Пресет «${preset.name}» обновлён.`, 2800);
}

async function onDeletePresetClick() {
  const preset = getSelectedPreset();
  if (!preset) return;
  const ok = await askAppConfirm(`Удалить пресет «${preset.name}»?`, "Удаление пресета");
  if (!ok) return;
  settingsPresets = settingsPresets.filter((p) => p.id !== preset.id);
  selectedPresetId = "";
  renderPresetSelect();
  await saveSettingsPresets();
  await savePopupPrefs();
  showAppToast("Пресет удалён.", 2400);
}

async function onApplyPresetClick() {
  const preset = getSelectedPreset();
  if (!preset) return;
  await applySettingsPreset(preset);
  showAppToast(`Пресет «${preset.name}» применён.`, 2800);
}

function cloneLayoutDeletionHistoryForPrefs(arr) {
  if (!Array.isArray(arr)) return [];
  try {
    return JSON.parse(JSON.stringify(arr));
  } catch {
    return [];
  }
}

function restoreLayoutDeletionHistoryFromPrefs(rawArr) {
  if (!Array.isArray(rawArr)) return [];
  const restored = [];
  for (const item of rawArr) {
    if (!item || typeof item !== "object") continue;
    const prefKey = item.prefKey === "layoutLt" ? "layoutLt" : item.prefKey === "layoutGe" ? "layoutGe" : "";
    if (!prefKey) continue;
    const index = Number(item.index);
    if (!Number.isFinite(index)) continue;
    const slot = normalizeLayoutSlot(item.slot);
    const id =
      typeof item.id === "string" && item.id
        ? item.id
        : typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `d${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    restored.push({
      id,
      prefKey,
      index: Math.max(0, Math.floor(index)),
      slot,
      title: String(item.title || ""),
    });
  }
  if (restored.length > LAYOUT_DELETION_HISTORY_MAX) {
    restored.length = LAYOUT_DELETION_HISTORY_MAX;
  }
  return restored;
}

function collectPopupPrefs() {
  syncTextInputFromTextarea();
  syncCurrentModeWorkspaceFromGlobals();
  return {
    settingsOpen: Boolean($("panelSettings") && !$("panelSettings").hidden),
    settingsActiveTab: getSettingsActiveTab(),
    prefsLayoutSchemaVersion: LAYOUT_PREFS_SCHEMA_VERSION,
    selectedPresetId: String(selectedPresetId || ""),
    threadsChoice: normalizeThreadsChoice(outputPrefs.threadsChoice),
    lastManualThreads: getLastManualThreads(),
    priceThreshold: $("priceThreshold")?.value ?? String(DEFAULT_PRICE_THRESHOLD),
    minPriceThreshold: $("minPriceThreshold")?.value ?? String(DEFAULT_MIN_PRICE_THRESHOLD),
    vulnerableMinPriceThreshold:
      $("vulnerableMinPriceThreshold")?.value ?? String(DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD),
    opsWarehouses: getOpsWarehousesList({ keepEmpty: true }),
    vulnerabilityKeywords: getVulnerabilityKeywordsList(),
    uiGradient: outputPrefs.uiGradient !== false,
    aggressiveMode: outputPrefs.aggressiveMode === true,
    excludeMemoryIds: outputPrefs.excludeMemoryIds === true,
    hyperlinksEnabled: areHyperlinksEnabled(),
    hyperlinkServiceArticleId: normalizeHyperlinkService(outputPrefs.hyperlinkServiceArticleId),
    hyperlinkServiceShipment: normalizeHyperlinkService(outputPrefs.hyperlinkServiceShipment),
    hubHyperlinks: areHyperlinksEnabled(),
    layoutGe: cloneLayoutForPrefs(outputPrefs.layoutGe),
    layoutLt: cloneLayoutForPrefs(outputPrefs.layoutLt),
    sourceMode: sourceState.mode,
    fileName: sourceState.file.fileName || "",
    fileNames: normalizeFileNamesList(sourceState.file.fileNames),
    fileStats: sourceState.file.stats ? cloneForUndo(sourceState.file.stats) : null,
    textInput: String(sourceState.textInput || ""),
    modeWorkspaceState: cloneForUndo(modeWorkspaceState),
    popupWidth: document.documentElement.clientWidth || POPUP_SIZE_DEFAULT.w,
    popupHeight: document.documentElement.clientHeight || POPUP_SIZE_DEFAULT.h,
  };
}

async function savePopupPrefs() {
  popupPrefsSaveChain = popupPrefsSaveChain
    .catch(() => {})
    .then(async () => {
      await persistSourceCache();
      await chrome.storage.local.set({ [POPUP_PREFS_KEY]: collectPopupPrefs() });
    });
  return popupPrefsSaveChain;
}

async function restorePopupPrefs() {
  const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
  const raw = prefs || {};
  selectedPresetId = typeof raw.selectedPresetId === "string" ? raw.selectedPresetId : "";
  outputPrefs.threadsChoice = normalizeThreadsChoice(raw.threadsChoice);
  outputPrefs.lastManualThreads = normalizeManualThreadsValue(
    raw.lastManualThreads,
    outputPrefs.threadsChoice === "auto" ? MANUAL_THREADS_DEFAULT : Number(outputPrefs.threadsChoice)
  );
  const restoredPriceThreshold = Number(raw.priceThreshold);
  outputPrefs.priceThreshold =
    Number.isFinite(restoredPriceThreshold) && restoredPriceThreshold >= 0
      ? restoredPriceThreshold
      : DEFAULT_PRICE_THRESHOLD;
  outputPrefs.minPriceThreshold = Math.max(
    0,
    Number(raw.minPriceThreshold ?? DEFAULT_MIN_PRICE_THRESHOLD) || DEFAULT_MIN_PRICE_THRESHOLD
  );
  outputPrefs.vulnerableMinPriceThreshold = Math.max(
    0,
    Number(raw.vulnerableMinPriceThreshold ?? DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD) ||
      DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD
  );
  outputPrefs.opsWarehouses = Array.isArray(raw.opsWarehouses)
    ? raw.opsWarehouses.map((x) => String(x ?? ""))
    : [];
  if (!outputPrefs.opsWarehouses.length) outputPrefs.opsWarehouses = [""];
  outputPrefs.vulnerabilityKeywords = Array.isArray(raw.vulnerabilityKeywords)
    ? sanitizeVulnerabilityKeywords(raw.vulnerabilityKeywords, { allowEmpty: true })
    : [...DEFAULT_VULNERABILITY_KEYWORDS];
  vulnerabilityKeywordMatcherCacheKey = "";
  vulnerabilityKeywordMatcherEntries = [];
  outputPrefs.uiGradient = raw.uiGradient !== false;
  outputPrefs.aggressiveMode = raw.aggressiveMode === true;
  outputPrefs.excludeMemoryIds = raw.excludeMemoryIds === true;
  if (typeof raw.hyperlinksEnabled === "boolean") {
    outputPrefs.hyperlinksEnabled = raw.hyperlinksEnabled;
  } else {
    outputPrefs.hyperlinksEnabled = raw.hubHyperlinks !== false;
  }
  outputPrefs.hyperlinkServiceArticleId = normalizeHyperlinkService(
    raw.hyperlinkServiceArticleId ?? "hub"
  );
  outputPrefs.hyperlinkServiceShipment = normalizeHyperlinkService(
    raw.hyperlinkServiceShipment ?? "hub"
  );
  let layoutSchemaReset = false;
  if (Number(raw.prefsLayoutSchemaVersion) !== LAYOUT_PREFS_SCHEMA_VERSION) {
    outputPrefs.layoutGe = layoutStringsToSlots(DEFAULT_LAYOUT_GE).map((s) => ({ ...s }));
    outputPrefs.layoutLt = layoutStringsToSlots(DEFAULT_LAYOUT_LT).map((s) => ({ ...s }));
    layoutSchemaReset = true;
  } else {
    outputPrefs.layoutGe = clampSlotsLength(
      migrateLayoutToSlots(raw.layoutGe, DEFAULT_LAYOUT_GE),
      DEFAULT_LAYOUT_GE
    );
    outputPrefs.layoutLt = clampSlotsLength(
      migrateLayoutToSlots(raw.layoutLt, DEFAULT_LAYOUT_LT),
      DEFAULT_LAYOUT_LT
    );
  }
  if (raw.sourceMode === "text" || raw.sourceMode === "file") {
    sourceState.mode = raw.sourceMode;
  }
  toggleSourceModeUi();
  applyOutputPrefsToUi({ rebuildLayout: false, rebuildLists: false });
  setSettingsTab(raw.settingsActiveTab === "layout" ? "layout" : "general", {
    skipSave: true,
    forceRebuild: false,
  });
  showSettingsPanel(Boolean(raw.settingsOpen), { skipSave: true });
  if (raw.settingsOpen) {
    applyOutputPrefsToUi({ rebuildLayout: false, rebuildLists: true });
    if (raw.settingsActiveTab === "layout" && !layoutPanelsBuilt()) {
      setSettingsTab("layout", { skipSave: true, forceRebuild: true });
    }
  }
  if (raw.fileName) sourceState.file.fileName = String(raw.fileName);
  sourceState.file.fileNames = normalizeFileNamesList(raw.fileNames);
  if (raw.fileStats && typeof raw.fileStats === "object") {
    sourceState.file.stats = {
      rows: Number(raw.fileStats.rows) || 0,
      missingIdRows: Number(raw.fileStats.missingIdRows) || 0,
    };
  }
  modeWorkspaceState = {
    file: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
    text: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
  };
  if (raw.modeWorkspaceState?.file) {
    modeWorkspaceState.file = {
      undoSourceSnapshot: cloneForUndo(raw.modeWorkspaceState.file.undoSourceSnapshot),
      hasJobUndo: Boolean(raw.modeWorkspaceState.file.hasJobUndo || raw.modeWorkspaceState.file.undoJobSnapshot),
      layoutDeletionHistory: restoreLayoutDeletionHistoryFromPrefs(raw.modeWorkspaceState.file.layoutDeletionHistory),
      textInput: String(raw.modeWorkspaceState.file.textInput ?? ""),
    };
  }
  if (raw.modeWorkspaceState?.text) {
    modeWorkspaceState.text = {
      undoSourceSnapshot: cloneForUndo(raw.modeWorkspaceState.text.undoSourceSnapshot),
      hasJobUndo: Boolean(raw.modeWorkspaceState.text.hasJobUndo || raw.modeWorkspaceState.text.undoJobSnapshot),
      layoutDeletionHistory: restoreLayoutDeletionHistoryFromPrefs(raw.modeWorkspaceState.text.layoutDeletionHistory),
      textInput: String(raw.modeWorkspaceState.text.textInput ?? raw.textInput ?? ""),
    };
  } else if (raw.textInput != null) {
    modeWorkspaceState.text.textInput = String(raw.textInput || "");
  }
  sourceState.textInput = String(modeWorkspaceState.text.textInput ?? raw.textInput ?? "");
  const migratedUndo = await migrateLegacyJobUndoFromPrefs(raw.modeWorkspaceState);
  for (const mode of ["file", "text"]) {
    if (modeWorkspaceState[mode]?.hasJobUndo && !modeUndoJobSnapshot[mode]) {
      try {
        await loadJobUndoSnapshot(mode);
      } catch {
      }
    }
  }
  applyModeWorkspaceToGlobals(getActiveModeKey());
  applyPopupSize(raw.popupWidth ?? POPUP_SIZE_DEFAULT.w, raw.popupHeight ?? POPUP_SIZE_DEFAULT.h);
  closeSecretKeywordsModal();
  refreshCopyButtonsText();
  if (layoutSchemaReset || migratedUndo) await savePopupPrefs();
  return Boolean(prefs);
}

function toggleSourceModeUi() {
  const isFileMode = sourceState.mode === "file";
  const fileWrap = document.querySelector(".file-source");
  if (fileWrap) fileWrap.hidden = !isFileMode;
  $("textSourceWrap").hidden = isFileMode;
  const fBtn = $("sourceModeFileBtn");
  const tBtn = $("sourceModeTextBtn");
  if (fBtn && tBtn) {
    fBtn.classList.toggle("is-active", isFileMode);
    fBtn.setAttribute("aria-checked", isFileMode ? "true" : "false");
    tBtn.classList.toggle("is-active", !isFileMode);
    tBtn.setAttribute("aria-checked", !isFileMode ? "true" : "false");
  }
}

function setSourceMeta(opts = {}) {
  const sourceHint = $("sourceHint");
  sourceHint.classList.remove("is-error");
  if (sourceState.mode === "file") {
    if (!sourceState.file.text) {
      if (sourceState.file.fileName) {
        const fileLabelHtml = buildFileNameDisplayHtml(sourceState.file.fileName, sourceState.file.fileNames);
        sourceHint.innerHTML = `Ранее выбран файл: ${fileLabelHtml}.`;
      } else {
        sourceHint.textContent = "Файл не выбран. Поддерживаются XLS/XLSX/XLSM/XLSB/XLTX/XLTM.";
      }
      return;
    }
    let rows = sourceState.file.stats?.rows;
    let missingIdRows = sourceState.file.stats?.missingIdRows;
    if (rows == null || opts.reparse) {
      const st = updateFileSourceStats(sourceState.file.text);
      rows = st.rows.length;
      missingIdRows = st.missingIdRows;
    }
    sourceHint.innerHTML = buildFileSourceHintHtml(
      sourceState.file.fileName,
      rows,
      missingIdRows,
      sourceState.file.fileNames
    );
  } else {
    sourceHint.textContent = "Вставьте строки таблицы в поле выше.";
  }
}

function setFileLoadProgress(stage, pct, busy = true) {
  const wrap = $("fileLoadWrap");
  if (!wrap) return;
  wrap.hidden = false;
  wrap.classList.toggle("is-busy", Boolean(busy));
  $("fileLoadStage").textContent = String(stage || "Обработка файла…");
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  $("fileLoadPct").textContent = `${safePct}%`;
  $("fileLoadFill").style.width = `${safePct}%`;
}

function hideFileLoadProgress() {
  const wrap = $("fileLoadWrap");
  if (!wrap) return;
  wrap.hidden = true;
  wrap.classList.remove("is-busy");
  $("fileLoadStage").textContent = "Подготовка…";
  $("fileLoadPct").textContent = "0%";
  $("fileLoadFill").style.width = "0%";
}

function toCsvLine(cells) {
  return cells
    .map((cell) => {
      const s = String(cell ?? "");
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(",");
}

function isExcelDateFormatCode(z) {
  if (z == null || z === "") return false;
  const s = String(z);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return (
      (n >= 14 && n <= 22) ||
      (n >= 27 && n <= 36) ||
      (n >= 45 && n <= 47) ||
      (n >= 50 && n <= 58)
    );
  }
  const lower = s.toLowerCase();
  if (/[dд]/.test(lower) && /[yг]/.test(lower)) return true;
  if (/[mм]/.test(lower) && /[dд]/.test(lower) && /[yг]/.test(lower)) return true;
  if (/[mmdyгд]/.test(lower) && /(dd|mm|yy|yyyy|дд|мм|гг)/i.test(s)) return true;
  return false;
}

function isExcelDateNumberCell(cell) {
  if (!cell || cell.v == null) return false;
  if (cell.t === "d") return true;
  if (cell.t !== "n" || typeof cell.v !== "number" || !Number.isFinite(cell.v)) return false;
  if (isExcelDateFormatCode(cell.z)) return true;
  const w = String(cell.w || "").trim();
  if (cell.v >= 20000 && cell.v <= 80000 && /^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?/.test(w)) {
    return true;
  }
  return false;
}

function formatExcelDateParts(parts) {
  if (!parts) return "";
  const pad = (n) => String(Math.floor(Number(n) || 0)).padStart(2, "0");
  const year = Number(parts.y || parts.Y || 0);
  const month = Number(parts.m || 0);
  const day = Number(parts.d || parts.D || 0);
  if (!year && !month && !day) return "";
  let text = `${pad(day)}.${pad(month)}.${year}`;
  const hours = Number(parts.H || 0);
  const minutes = Number(parts.M || 0);
  const seconds = Number(parts.S || 0);
  if (hours || minutes || seconds) {
    text += ` ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return text;
}

function excelCellToDateSerial(cell) {
  if (!cell || cell.v == null) return null;
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) return cell.v;
  if (cell.v instanceof Date) {
    return (cell.v.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
  }
  return null;
}

function formatExcelDateCell(cell) {
  if (typeof XLSX === "undefined" || typeof XLSX.SSF?.parse_date_code !== "function") return "";
  const serial = excelCellToDateSerial(cell);
  if (serial == null) return "";
  const parts = XLSX.SSF.parse_date_code(serial);
  return formatExcelDateParts(parts);
}

function sheetCellToText(ws, addr) {
  let cell = ws[addr];
  if (!cell && Array.isArray(ws)) {
    const pos = XLSX.utils.decode_cell(addr);
    cell = ws[pos.r]?.[pos.c];
  }
  if (!cell) return "";

  if (cell.t === "s" || cell.t === "str" || cell.t === "inlineStr") {
    return cell.v != null ? String(cell.v) : cell.w != null ? String(cell.w) : "";
  }

  if (cell.t === "b") return cell.v ? "TRUE" : "FALSE";

  if (isExcelDateNumberCell(cell)) {
    const formatted = formatExcelDateCell(cell);
    if (formatted) return formatted;
  }

  if (cell.z != null && cell.v != null && typeof XLSX !== "undefined" && XLSX.SSF?.format) {
    if (!isExcelDateFormatCode(cell.z)) {
      try {
        const formatted = XLSX.SSF.format(cell.z, cell.v);
        if (formatted != null && String(formatted) !== "") return String(formatted);
      } catch {}
    }
  }

  if (cell.w != null && String(cell.w) !== "") return String(cell.w);

  if (cell.v == null) return "";
  if (cell.v instanceof Date) {
    const serial = excelCellToDateSerial(cell);
    const formatted = serial != null ? formatExcelDateCell({ ...cell, v: serial, t: "n" }) : "";
    if (formatted) return formatted;
  }
  return String(cell.v);
}

async function sheetToVisibleCellRows(ws, onProgress) {
  const ref = ws?.["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const endCol = Math.min(range.e.c, MAX_SRC_COL_INDEX);
  if (endCol < range.s.c) return [];
  const out = [];
  const rowSet = new Set();
  for (const key of Object.keys(ws || {})) {
    if (key[0] === "!") continue;
    const addr = XLSX.utils.decode_cell(key);
    if (addr.r < range.s.r || addr.r > range.e.r) continue;
    if (addr.c < range.s.c || addr.c > endCol) continue;
    rowSet.add(addr.r);
  }
  const candidateRows = Array.from(rowSet).sort((a, b) => a - b);
  const totalRows = Math.max(1, candidateRows.length);
  const MAX_SCAN_ROWS = 520000;
  if (totalRows > MAX_SCAN_ROWS) {
    throw new Error(
      `Файл содержит слишком большой диапазон строк (${totalRows}). ` +
        "Похоже, в листе «растянут» used range. Скопируйте данные на новый чистый лист и загрузите снова."
    );
  }

  for (let i = 0; i < candidateRows.length; i++) {
    const r = candidateRows[i];
    const row = [];
    let hasValue = false;
    for (let c = 0; c <= endCol; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const value = sheetCellToText(ws, addr);
      if (value !== "") hasValue = true;
      row.push(value);
    }
    if (!hasValue) continue;
    out.push(row);
    if (out.length > MAX_VISIBLE_SOURCE_ROWS) {
      throw new Error(
        `Слишком большой объём строк (${out.length}). Лимит: ${MAX_VISIBLE_SOURCE_ROWS}. Разделите файл на части.`
      );
    }
    if (i % 80 === 0) {
      if (typeof onProgress === "function") {
        onProgress(Math.round(((i + 1) / totalRows) * 100));
      }
      await yieldToUI();
    }
  }

  if (typeof onProgress === "function") onProgress(100);
  return out;
}

async function sheetToCsvVisibleRows(ws, onProgress) {
  const rows = await sheetToVisibleCellRows(ws, onProgress);
  return rows.map((row) => toCsvLine(row)).join("\n");
}

function looksLikeExcelFile(file) {
  const name = String(file?.name || "").toLowerCase();
  return /\.(xls|xlsx|xlsm|xlsb|xltx|xltm)$/.test(name);
}

function buildMergedSourceCsv(mergedById, headerCells = []) {
  const rows = [...mergedById.values()];
  if (!rows.length) return "";
  const maxCols = Math.max(
    Array.isArray(headerCells) ? headerCells.length : 0,
    ...rows.map((row) =>
      Array.isArray(row.sourceCells) && row.sourceCells.length
        ? row.sourceCells.length
        : 4
    )
  );
  const lines = [];
  if (Array.isArray(headerCells) && headerCells.length) {
    const hdr = headerCells.map((cell) => String(cell ?? ""));
    while (hdr.length < maxCols) hdr.push("");
    lines.push(toCsvLine(hdr));
  }
  for (const row of rows) {
    const cells =
      Array.isArray(row.sourceCells) && row.sourceCells.length
        ? row.sourceCells.map((cell) => String(cell ?? ""))
        : [
            String(row.warehouse || ""),
            String(row.articleId || ""),
            String(row.operationalWarehouse || ""),
            String(row.shipmentSource || ""),
          ];
    while (cells.length < maxCols) cells.push("");
    lines.push(toCsvLine(cells));
  }
  return lines.join("\n");
}

function mergeParsedRowsById(mergedById, parsedRows) {
  let added = 0;
  const rows = Array.isArray(parsedRows) ? parsedRows : [];
  for (const row of rows) {
    const id = String(row?.articleId || "").trim();
    if (!id || mergedById.has(id)) continue;
    mergedById.set(id, {
      warehouse: String(row?.warehouse || ""),
      articleId: id,
      operationalWarehouse: String(row?.operationalWarehouse || ""),
      shipmentSource: String(row?.shipmentSource || ""),
      postingType: String(row?.postingType || ""),
      sourceCells: Array.isArray(row.sourceCells) ? row.sourceCells.slice() : [],
    });
    added += 1;
  }
  return added;
}

async function extractWorkbookSourceData(wb) {
  const sheetNames = Array.isArray(wb?.SheetNames) ? wb.SheetNames : [];
  if (!sheetNames.length) {
    throw new Error("В файле нет листов.");
  }

  const mergedById = new Map();
  let bestSheet = null;
  let sheetsWithIds = 0;
  let firstError = null;
  for (let i = 0; i < sheetNames.length; i++) {
    const name = sheetNames[i];
    const ws = wb.Sheets[name];
    if (!ws) continue;
    try {
      const from = Math.round((i / sheetNames.length) * 88);
      const span = Math.max(1, Math.round(88 / sheetNames.length));
      const cellRows = await sheetToVisibleCellRows(ws, (pct) => {
        const scaled = 10 + Math.min(88, from + Math.round((Math.max(0, Math.min(100, pct)) * span) / 100));
        setFileLoadProgress(`Анализ листов… ${i + 1}/${sheetNames.length}: ${name}`, scaled, true);
      });
      if (!Array.isArray(cellRows) || !cellRows.length) continue;
      setFileLoadProgress(
        `Разбор ID… ${i + 1}/${sheetNames.length}: ${name}`,
        Math.min(98, 10 + from + span),
        true
      );
      await yieldToUI();
      const parsed = parseSourceCellRowsClient(cellRows, true);
      const parsedRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      const idRows = Number(parsedRows.length || 0);
      if (idRows <= 0) continue;
      sheetsWithIds += 1;
      for (const row of parsedRows) {
        const id = String(row?.articleId || "").trim();
        if (!id || mergedById.has(id)) continue;
        mergedById.set(id, {
          warehouse: String(row?.warehouse || ""),
          articleId: id,
          operationalWarehouse: String(row?.operationalWarehouse || ""),
          shipmentSource: String(row?.shipmentSource || ""),
          postingType: String(row?.postingType || ""),
          sourceCells: Array.isArray(row.sourceCells) ? row.sourceCells.slice() : [],
        });
      }
      const headerText = String((parsed?.headerCells || []).join(" ")).toLowerCase();
      const hasIdLikeHeader =
        /идентификатор|постинг|отправлен|shipment|posting|identifier/.test(headerText);
      const score = idRows + (hasIdLikeHeader ? 100000 : 0);
      if (!bestSheet || score > bestSheet.score) {
        bestSheet = {
          sheetName: name,
          score,
          idRows,
          headerCells: Array.isArray(parsed.headerCells) ? parsed.headerCells.slice() : [],
        };
      }
    } catch (e) {
      if (!firstError) firstError = e;
    }
    await yieldToUI();
  }

  if (mergedById.size > 0) {
    const headerCells = bestSheet?.headerCells || [];
    return {
      csvText: buildMergedSourceCsv(mergedById, headerCells),
      idsCount: mergedById.size,
      sheetsWithIds,
      bestSheetName: String(bestSheet?.sheetName || ""),
      headerCells,
    };
  }
  if (firstError) throw firstError;
  throw new Error("В файле нет строк с данными для обработки.");
}

async function loadSourceFiles(fileList) {
  const files = (Array.isArray(fileList) ? fileList : Array.from(fileList || [])).filter(Boolean);
  if (!files.length) return;
  const selectedFileNames = normalizeFileNamesList(files.map((f) => f?.name));
  const invalidFiles = files.filter((file) => !looksLikeExcelFile(file));
  if (invalidFiles.length) {
    const firstInvalidName = String(invalidFiles[0]?.name || "");
    const more = invalidFiles.length > 1 ? ` (+${invalidFiles.length - 1})` : "";
    $("sourceHint").textContent =
      `Нужны Excel-файлы: XLS/XLSX/XLSM/XLSB/XLTX/XLTM. Неподходящий файл: ${firstInvalidName}${more}.`;
    $("sourceHint").classList.add("is-error");
    return;
  }
  const rndPct = 8 + Math.floor(Math.random() * 20);
  
  resetJobProgressUi({ show: false });
  setFileLoadProgress(files.length > 1 ? "Загрузка файлов…" : "Загрузка…", rndPct, true);
  try {
    await ensureXlsxLoaded();
    const mergedById = new Map();
    const fileSummaries = [];
    let filesWithIds = 0;
    let sheetsWithIdsTotal = 0;
    let firstError = null;
    let mergedHeaderCells = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const stagePrefix =
        files.length > 1 ? `Файл ${i + 1}/${files.length}: ${file.name}` : `Файл: ${file.name}`;
      setFileLoadProgress(`${stagePrefix} — разбор…`, Math.min(95, rndPct + Math.round((i / files.length) * 72)), true);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const wb = XLSX.read(arrayBuffer, {
          type: "array",
          cellStyles: true,
          cellNF: true,
        });
        const workbookData = await extractWorkbookSourceData(wb);
        if (!mergedHeaderCells.length && Array.isArray(workbookData.headerCells) && workbookData.headerCells.length) {
          mergedHeaderCells = workbookData.headerCells.slice();
        }
        const parsed = parseSourceRowsClient(workbookData.csvText, true);
        const addedCount = mergeParsedRowsById(mergedById, parsed?.rows || []);
        if (addedCount > 0) filesWithIds += 1;
        sheetsWithIdsTotal += Number(workbookData.sheetsWithIds) || 0;
        fileSummaries.push({
          fileName: file.name,
          sheetsTotal: Array.isArray(wb.SheetNames) ? wb.SheetNames.length : 0,
          sheetsWithIds: Number(workbookData.sheetsWithIds) || 0,
          bestSheetName: String(workbookData.bestSheetName || ""),
        });
      } catch (err) {
        if (!firstError) firstError = err;
      }
      await yieldToUI();
    }
    if (mergedById.size <= 0) {
      if (firstError) throw firstError;
      throw new Error("В выбранных файлах нет строк с данными для обработки.");
    }

    const mergedCsvText = buildMergedSourceCsv(mergedById, mergedHeaderCells);
    const fileNameSummary = buildFileNameSummary(selectedFileNames);
    sourceState.file = {
      text: mergedCsvText,
      fileName: fileNameSummary,
      fileNames: selectedFileNames,
      stats: null,
      sourceExportData: null,
    };
    const activeText = getActiveSourceText();
    sourceState.file.sourceExportData = buildSourceExportDataFromMergedMap(
      mergedById,
      mergedHeaderCells,
      activeText
    );
    exportSourceDataMapKey = activeText;
    exportSourceDataMap = {
      rowsByArticle: sourceState.file.sourceExportData.rowsByArticle,
      headerLookup: sourceState.file.sourceExportData.headerLookup,
    };
    updateFileSourceStats(mergedCsvText, { skipExportRebuild: true });
    sourceState.mode = "file";
    toggleSourceModeUi();
    setSourceMeta();
    await savePopupPrefs();

    if (files.length > 1) {
      showAppToast(
        `Собрано ID из ${files.length} файлов: ${mergedById.size} (файлов с ID: ${filesWithIds}, листов с ID: ${sheetsWithIdsTotal})`,
        3600
      );
    } else {
      const single = fileSummaries[0] || null;
      if ((single?.sheetsTotal || 0) > 1) {
        const bestName = single?.bestSheetName ? `, лучший лист: ${single.bestSheetName}` : "";
        showAppToast(
          `Собрано ID со всех листов: ${mergedById.size} (листов с ID: ${single?.sheetsWithIds || 0}${bestName})`,
          3400
        );
      }
    }

    if (files.length > 1 && firstError) {
      showAppToast(
        "Некоторые файлы не удалось прочитать, но доступные ID из остальных файлов загружены.",
        3400
      );
    }

    setFileLoadProgress("Готово", 100, false);
    setTimeout(hideFileLoadProgress, 500);
    await refresh();
  } catch (err) {
    const failName = buildFileNameSummary(selectedFileNames);
    sourceState.file = {
      text: "",
      fileName: failName,
      fileNames: selectedFileNames,
      stats: null,
    };
    sourceState.mode = "file";
    toggleSourceModeUi();
    $("sourceHint").textContent =
      "Не удалось прочитать Excel-файл(ы). Проверьте, что в файлах есть строки и хотя бы один лист с ID.";
    $("sourceHint").classList.add("is-error");
    $("status").textContent = String(err?.message || err);
    hideFileLoadProgress();
    await refresh();
  }
}

function invalidateRunUndo() {
  undoSourceSnapshot = null;
  undoJobSnapshot = null;
  modeUndoJobSnapshot = { file: null, text: null };
  clearedJobModes.clear();
  void chrome.storage.local.remove([JOB_UNDO_KEY_FILE, JOB_UNDO_KEY_TEXT]);
  resetLayoutDeletionHistory();
  setUndoEnabled("undoClearSource", false);
  setUndoEnabled("undoClearJob", false);
  syncCurrentModeWorkspaceFromGlobals();
}

function launchConfetti() {
  const colors = ["#005bff", "#00a6ff", "#12a150", "#f53c14", "#ffd166"];
  const count = 80;
  const vh = typeof window.innerHeight === "number" ? window.innerHeight : 800;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    const size = 4 + Math.random() * 6;
    const dur = 3200 + Math.random() * 1800;
    const fadeDur = 700;
    const fadeDelay = Math.max(0, dur - fadeDur - 120);
    const fallPx = vh + 100 + Math.random() * 180;
    const drift = (Math.random() - 0.5) * 220;
    const rot0 = Math.random() * 360;
    const rot1 = rot0 + 400 + Math.random() * 500;
    piece.style.position = "fixed";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.top = `${-24 - Math.random() * 48}px`;
    piece.style.width = `${size}px`;
    piece.style.height = `${size * 1.6}px`;
    piece.style.borderRadius = "2px";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.opacity = "1";
    piece.style.pointerEvents = "none";
    piece.style.zIndex = "99999";
    piece.style.willChange = "transform, opacity";
    piece.style.transform = `translate(0px, 0px) rotate(${rot0}deg)`;
    piece.style.transition = `transform ${dur}ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity ${fadeDur}ms ease-in ${fadeDelay}ms`;
    document.body.append(piece);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        piece.style.transform = `translate(${drift}px, ${fallPx}px) rotate(${rot1}deg)`;
        piece.style.opacity = "0";
      });
    });
    setTimeout(() => piece.remove(), dur + fadeDur + 150);
  }
}

function onLogoTap() {
  const now = Date.now();
  logoClicks = logoClicks.filter((t) => now - t < 2000);
  logoClicks.push(now);
  if (logoClicks.length < 3) return;
  logoClicks = [];
  launchConfetti();
  const node = document.createDocumentFragment();
  node.append("Разработка ");
  const a = document.createElement("a");
  a.href = "https://staff.o3t.ru/profile/eovakimyan";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "@eovakimyan";
  node.append(a);
  showAppToast("", 3200, { htmlNode: node });
}

function closeSecretKeywordsModal() {
  const modal = $("secretKeywordsModal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
  secretKeywordsSearchQuery = "";
  const searchInput = $("secretKeywordsSearch");
  if (searchInput) searchInput.value = "";
  secretKeywordsModalOpen = false;
}

function openSecretKeywordsModal() {
  const modal = $("secretKeywordsModal");
  if (!modal) return;
  secretKeywordsSearchQuery = "";
  const searchInput = $("secretKeywordsSearch");
  if (searchInput) searchInput.value = "";
  renderVulnerabilityKeywordsList("secretKeywordsList");
  modal.hidden = false;
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  secretKeywordsModalOpen = true;
  setTimeout(() => {
    const search = $("secretKeywordsSearch");
    if (search && typeof search.focus === "function") {
      search.focus();
      if (typeof search.select === "function") search.select();
    } else {
      $("btnAddSecretKeyword")?.focus();
    }
  }, 0);
}

function focusFirstSecretKeywordInput() {
  const modal = $("secretKeywordsModal");
  const firstInput = modal?.querySelector?.('#secretKeywordsList input[type="text"]');
  if (firstInput && typeof firstInput.focus === "function") {
    firstInput.focus();
    if (typeof firstInput.select === "function") firstInput.select();
  }
}

async function tryUnlockSecretSettings() {
  if (secretKeywordsModalOpen) return;
  const password = await askAppInput({
    title: "Секретные настройки",
    message: "Введите пароль для открытия окна управления кейвордами уязвимости.",
    placeholder: "Пароль",
    okText: "Открыть",
    cancelText: "Отмена",
    inputType: "password",
  });
  if (password == null) return;
  const hash = await sha256Hex(password);
  if (hash !== CACHE_CLEAR_HASH) {
    showAppToast("Неверный пароль.", 3200);
    return;
  }
  openSecretKeywordsModal();
  await savePopupPrefs();
  showAppToast("Окно секретных настроек открыто.", 2200);
}

async function copyFilteredRows(kind) {
  const job = await getJob();
  const rows = kind === "ge10k" ? rowsGe10k(job) : rowsLt10k(job);
  const tsv = buildTsvFromResults(rows, kind);
  if (!tsv) return;
  const btn = kind === "ge10k" ? $("copyGt10k") : $("copyLt10k");
  const waveP = playButtonLightWave(btn);
  await navigator.clipboard.writeText(tsv);
  await addProcessedIds(rows.map((r) => r.articleId));
  await waveP;
  await flashCopiedButton(btn, copyButtonLabels[kind], { alreadyWaved: true });
}

async function copyVulnerableRows() {
  const job = await getJob();
  const rows = rowsVulnerable(job);
  const tsv = buildTsvFromResults(rows, "ge10k");
  if (!tsv) return;
  const btn = $("copyVulnerable");
  const waveP = playButtonLightWave(btn);
  await navigator.clipboard.writeText(tsv);
  await addProcessedIds(rows.map((r) => r.articleId));
  await waveP;
  await flashCopiedButton(btn, copyButtonLabels.vulnerable, { alreadyWaved: true });
}

async function copyAllRows() {
  const job = await getJob();
  const rows = rowsAll(job);
  const kind = getLayoutKindWithMoreColumns();
  const tsv = buildTsvFromResults(rows, kind);
  if (!tsv) return;
  const btn = $("copyAllRows");
  const waveP = playButtonLightWave(btn);
  await navigator.clipboard.writeText(tsv);
  await addProcessedIds(rows.map((r) => r.articleId));
  await waveP;
  await flashCopiedButton(btn, copyButtonLabels.allRows, { alreadyWaved: true });
}

function failedPostingIdsFromJob(job) {
  const errors = Array.isArray(job?.errors) ? job.errors : [];
  const ids = [];
  const seen = new Set();
  for (const e of errors) {
    const id = String(e?.articleId || "").trim();
    if (!id || id === "-") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const BTN_LIGHT_WAVE_MS = 750;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function playButtonLightWave(btn) {
  if (!btn || prefersReducedMotion()) return;
  btn.classList.remove("btn-wave-play");
  
  void btn.offsetWidth;
  btn.classList.add("btn-wave-play");
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      btn.removeEventListener("animationend", onEnd);
      btn.classList.remove("btn-wave-play");
      resolve();
    };
    const onEnd = (e) => {
      if (e.target !== btn) return;
      const name = String(e.animationName || "");
      if (name && name !== "btnLightWave") return;
      finish();
    };
    btn.addEventListener("animationend", onEnd);
    setTimeout(finish, BTN_LIGHT_WAVE_MS + 100);
  });
}

async function flashCopiedButton(btn, restoreLabel, { alreadyWaved = false } = {}) {
  if (!btn) return;
  
  const keepW = Math.ceil(btn.getBoundingClientRect().width);
  btn.style.minWidth = `${keepW}px`;
  btn.classList.remove("btn-copied", "btn-copied-out");
  btn.style.opacity = "";
  btn.style.filter = "";
  btn.style.transition = "";
  if (!alreadyWaved) await playButtonLightWave(btn);

  const reduced = prefersReducedMotion();
  const settleMs = reduced ? 0 : 280;
  const holdMs = reduced ? 1200 : 1500;

  btn.textContent = "Скопировано ✓";
  btn.classList.add("btn-copied");
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));

  await new Promise((r) => setTimeout(r, holdMs));

  
  btn.textContent = restoreLabel;
  btn.classList.remove("btn-copied", "btn-copied-out");
  if (settleMs) {
    btn.style.filter = "brightness(1.1)";
    void btn.offsetWidth;
    btn.style.transition = `filter ${settleMs}ms ease`;
    btn.style.filter = "none";
    await new Promise((r) => setTimeout(r, settleMs));
    btn.style.filter = "";
    btn.style.transition = "";
  }

  btn.style.minWidth = "";
}

async function copyJobErrors() {
  const job = await getJob();
  const ids = failedPostingIdsFromJob(job);
  if (!ids.length) return;
  
  const btn = $("copyJobErrors");
  const waveP = playButtonLightWave(btn);
  await navigator.clipboard.writeText(ids.join("\n"));
  await waveP;
  await flashCopiedButton(btn, copyButtonLabels.errors, { alreadyWaved: true });
}

$("sourceFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  await loadSourceFiles(files);
  if ($("sourceFile")) $("sourceFile").value = "";
});

function initSourceFileDrop() {
  const fileWrap = document.querySelector(".file-source");
  if (!fileWrap) return;
  let dragDepth = 0;
  const setDropState = (on) => fileWrap.classList.toggle("is-drop-target", Boolean(on));
  const hasFilePayload = (event) =>
    Boolean(event?.dataTransfer?.types && [...event.dataTransfer.types].includes("Files"));

  fileWrap.addEventListener("dragenter", (event) => {
    if (sourceState.mode !== "file" || !hasFilePayload(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDropState(true);
  });
  fileWrap.addEventListener("dragover", (event) => {
    if (sourceState.mode !== "file" || !hasFilePayload(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDropState(true);
  });
  fileWrap.addEventListener("dragleave", (event) => {
    if (sourceState.mode !== "file") return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropState(false);
  });
  fileWrap.addEventListener("drop", (event) => {
    if (sourceState.mode !== "file") return;
    event.preventDefault();
    dragDepth = 0;
    setDropState(false);
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    void loadSourceFiles(Array.from(files));
  });
}

$("run").addEventListener("click", async () => {
  const sourceText = getActiveSourceText();
  if (!sourceText) {
    $("status").textContent =
      sourceState.mode === "file"
        ? "Сначала выберите файл исходника."
        : "Сначала вставьте строки в поле ввода.";
    return;
  }
  await playButtonLightWave($("run"));
  
  try {
    await persistSourceCache();
  } catch {
  }
  clearedJobModes.delete(getActiveModeKey());
  modeLastJobState[getActiveModeKey()] = null;
  lastJobState = null;
  resetJobProgressUi({ show: true, label: "Запуск…" });
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "START_BATCH",
      sourceFromCache: true,
      sourceText,
      sourceMode: getActiveModeKey(),
      sourceName: getActiveSourceName(),
      sourceVisibleCount: getActiveSourceVisibleCount(),
      threads: getManualThreadsCount(),
      opsWarehouses: getOpsWarehousesList(),
      aggressiveMode: outputPrefs.aggressiveMode === true,
    });
  } catch (err) {
    $("status").textContent = `Ошибка запуска: ${String(err?.message || err)}`;
    return;
  }
  if (!res?.ok) return ($("status").textContent = res?.error || "Не удалось запустить");
  invalidateRunUndo();
  try {
    await savePopupPrefs();
  } catch {
  }
  await refresh();
});

$("pause").addEventListener("click", () => {
  void (async () => {
    if (runControlBusy) return;
    const job = lastJobState || (await getJob());
    if (!job || (job.phase !== "running" && job.phase !== "paused")) return;
    runControlBusy = true;
    const willPause = job.phase === "running";
    render({
      ...job,
      phase: willPause ? "paused" : "running",
      currentArticleId: willPause ? null : job.currentArticleId,
    });
    try {
      
      try {
        await savePopupPrefs();
      } catch {
      }
      const msg = willPause
        ? { type: "PAUSE_BATCH", sourceMode: getActiveModeKey() }
        : {
            type: "RESUME_BATCH",
            sourceMode: getActiveModeKey(),
            opsWarehouses: getOpsWarehousesList(),
          };
      await chrome.runtime.sendMessage(msg);
      await refresh();
    } catch (err) {
      $("status").textContent = String(err?.message || err);
    } finally {
      runControlBusy = false;
      await refresh();
    }
  })();
});
$("stop").addEventListener("click", () => {
  void (async () => {
    if (runControlBusy) return;
    const job = lastJobState || (await getJob());
    runControlBusy = true;
    if (job && (job.phase === "running" || job.phase === "paused")) {
      render({ ...job, phase: "aborted", currentArticleId: null, stopReason: "Остановлено пользователем." });
    }
    try {
      await chrome.runtime.sendMessage({ type: "ABORT_BATCH", sourceMode: getActiveModeKey() });
    } catch (err) {
      $("status").textContent = String(err?.message || err);
    } finally {
      runControlBusy = false;
      await refresh();
    }
  })();
});

$("copyGt10k").addEventListener("click", () => copyFilteredRows("ge10k"));
$("copyLt10k").addEventListener("click", () => copyFilteredRows("lt10k"));
$("copyVulnerable")?.addEventListener("click", () => copyVulnerableRows());
$("copyAllRows")?.addEventListener("click", () => copyAllRows());
$("copyJobErrors")?.addEventListener("click", () => copyJobErrors());

$("clearSource").addEventListener("click", async () => {
  const mode = getActiveModeKey();
  if (mode === "file") {
    const hasAnythingToClear = Boolean(sourceState.file?.text || sourceState.file?.fileName);
    undoSourceSnapshot = hasAnythingToClear ? { mode: "file", file: cloneForUndo(sourceState.file) } : null;
    sourceState.file = { text: "", fileName: "", fileNames: [], stats: null, sourceExportData: null };
    $("sourceFile").value = "";
    if (globalThis.__goodsAuditCache) await globalThis.__goodsAuditCache.clearSourceCache("file");
  } else {
    syncTextInputFromTextarea();
    const snapshotText = String(sourceState.textInput ?? "");
    const hasAnythingToClear = snapshotText.length > 0;
    undoSourceSnapshot = hasAnythingToClear ? { mode: "text", textInput: snapshotText } : null;
    sourceState.textInput = "";
    modeWorkspaceState.text.textInput = "";
    $("sourceText").value = "";
  }
  setUndoEnabled("undoClearSource", Boolean(undoSourceSnapshot));
  syncCurrentModeWorkspaceFromGlobals();
  setSourceMeta();
  await refresh();
  await savePopupPrefs();
});
$("undoClearSource").addEventListener("click", async () => {
  if (!undoSourceSnapshot) return;
  if (undoSourceSnapshot.mode === "file" && undoSourceSnapshot.file) {
    sourceState.file = cloneForUndo(undoSourceSnapshot.file) || { text: "", fileName: "" };
  } else if (undoSourceSnapshot.mode === "text") {
    const restored = String(undoSourceSnapshot.textInput ?? "");
    sourceState.textInput = restored;
    modeWorkspaceState.text.textInput = restored;
    $("sourceText").value = restored;
    if (sourceState.mode !== "text") {
      sourceState.mode = "text";
      toggleSourceModeUi();
    }
  }
  undoSourceSnapshot = null;
  setUndoEnabled("undoClearSource", false);
  syncCurrentModeWorkspaceFromGlobals();
  toggleSourceModeUi();
  setSourceMeta();
  await refresh();
  await savePopupPrefs();
});

$("clearJob").addEventListener("click", () => {
  const activeMode = getActiveModeKey();
  const phase = lastJobState?.phase;
  if (phase === "running" || phase === "paused") return;
  if (!lastJobState && !modeLastJobState[activeMode] && !clearedJobModes.has(activeMode)) return;

  
  const jobRef = lastJobState || modeLastJobState[activeMode] || modeUndoJobSnapshot[activeMode];
  const jobKey = getJobKeyByMode(activeMode);
  const undoKey = getJobUndoKeyByMode(activeMode);

  
  
  clearedJobModes.add(activeMode);
  if (storageJobRenderRaf != null) {
    cancelAnimationFrame(storageJobRenderRaf);
    storageJobRenderRaf = null;
  }
  storageJobPending = null;
  undoJobSnapshot = jobRef || undoJobSnapshot || null;
  modeUndoJobSnapshot[activeMode] = undoJobSnapshot;
  setUndoEnabled("undoClearJob", Boolean(undoJobSnapshot));
  modeLastJobState[activeMode] = null;
  modeWorkspaceState[activeMode] = {
    ...(modeWorkspaceState[activeMode] || {}),
    hasJobUndo: Boolean(undoJobSnapshot),
    undoSourceSnapshot: modeWorkspaceState[activeMode]?.undoSourceSnapshot ?? null,
    layoutDeletionHistory: modeWorkspaceState[activeMode]?.layoutDeletionHistory || [],
    textInput: String(modeWorkspaceState[activeMode]?.textInput ?? sourceState.textInput ?? ""),
  };

  
  
  clearResultUiInstant();

  void (async () => {
    try {
      await chrome.runtime.sendMessage({ type: "CLEAR_JOB", sourceMode: activeMode });
    } catch {
      try {
        await chrome.storage.local.remove(jobKey);
      } catch {
      }
    }
    
    await new Promise((r) => setTimeout(r, 250));
    try {
      await chrome.storage.local.remove(jobKey);
    } catch {
    }
    
    if (clearedJobModes.has(activeMode) && !lastJobState) {
      
    }
    try {
      if (jobRef) await chrome.storage.local.set({ [undoKey]: jobRef });
    } catch {
    }
    try {
      await savePopupPrefs();
    } catch {
    }
  })();
});

$("undoClearJob").addEventListener("click", () => {
  void (async () => {
    const activeMode = getActiveModeKey();
    const snapshot = await loadJobUndoSnapshot(activeMode);
    if (!snapshot) {
      setUndoEnabled("undoClearJob", false);
      return;
    }
    clearedJobModes.delete(activeMode);
    try {
      await chrome.runtime.sendMessage({ type: "RELEASE_JOB_CLEAR", sourceMode: activeMode });
    } catch {
    }
    modeLastJobState[activeMode] = snapshot;
    lastJobState = snapshot;
    undoJobSnapshot = null;
    modeUndoJobSnapshot[activeMode] = null;
    setUndoEnabled("undoClearJob", false);
    modeWorkspaceState[activeMode] = {
      ...(modeWorkspaceState[activeMode] || {}),
      hasJobUndo: false,
    };
    render(snapshot);
    void (async () => {
      try {
        await chrome.storage.local.set({ [getJobKeyByMode(activeMode)]: snapshot });
        await chrome.storage.local.remove(getJobUndoKeyByMode(activeMode));
      } catch {
      }
      try {
        await savePopupPrefs();
      } catch {
      }
    })();
  })();
});

$("clearMem").addEventListener("click", async () => {
  const ok = await askClearMemoryCaptcha();
  if (!ok) return;
  await chrome.storage.local.remove([PROCESSED_KEY, RESULTS_CACHE_KEY]);
  await refresh();
  $("status").textContent = "Память ID и кэш результатов очищены.";
  showAppToast("Память ID сброшена.", 3200);
});

$("threadsMode")?.addEventListener("change", async () => {
  const manual = $("threadsMode")?.value === "manual";
  outputPrefs.threadsChoice = manual ? String(getLastManualThreads()) : "auto";
  applyThreadsChoiceToDom();
  if (manual) {
    const input = $("threadsManual");
    if (input) {
      input.focus();
      if (typeof input.select === "function") input.select();
    }
  }
  await savePopupPrefs();
});

$("threadsManual")?.addEventListener("input", () => {
  const raw = $("threadsManual")?.value ?? "";
  if (String(raw).trim() === "") return;
  const count = normalizeManualThreadsValue(raw, getLastManualThreads());
  outputPrefs.threadsChoice = String(count);
  outputPrefs.lastManualThreads = count;
  schedulePopupPrefsSave(180);
});

$("threadsManual")?.addEventListener("blur", async () => {
  const count = normalizeManualThreadsValue($("threadsManual")?.value, getLastManualThreads());
  outputPrefs.threadsChoice = String(count);
  outputPrefs.lastManualThreads = count;
  applyThreadsChoiceToDom();
  await savePopupPrefs();
});

$("priceThreshold").addEventListener("input", () => {
  outputPrefs.priceThreshold = Math.max(0, Number($("priceThreshold").value) || 0);
  refreshCopyButtonsText();
  clearTimeout(priceThresholdDebounceTimer);
  priceThresholdDebounceTimer = setTimeout(() => {
    priceThresholdDebounceTimer = null;
    void (async () => {
      await savePopupPrefs();
      await refresh();
    })();
  }, 280);
});

$("uiGradientToggle")?.addEventListener("change", async () => {
  outputPrefs.uiGradient = Boolean($("uiGradientToggle")?.checked);
  applyUiGradientToDom();
  await savePopupPrefs();
});

$("aggressiveModeToggle")?.addEventListener("change", () => {
  const on = Boolean($("aggressiveModeToggle")?.checked);
  outputPrefs.aggressiveMode = on;
  void (async () => {
    try {
      const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
      await chrome.storage.local.set({
        [POPUP_PREFS_KEY]: { ...(prefs && typeof prefs === "object" ? prefs : {}), aggressiveMode: on },
      });
    } catch {
    }
    try {
      await chrome.runtime.sendMessage({
        type: "UPDATE_AGGRESSIVE_MODE",
        sourceMode: getActiveModeKey(),
        aggressiveMode: on,
      });
    } catch {
    }
    void savePopupPrefs();
  })();
});

$("excludeMemoryIdsToggle")?.addEventListener("change", () => {
  outputPrefs.excludeMemoryIds = Boolean($("excludeMemoryIdsToggle")?.checked);
  rowBandCache = { key: "", ge: [], lt: [], below: [], vulnerable: [], all: [] };
  void (async () => {
    try {
      const { [POPUP_PREFS_KEY]: prefs } = await chrome.storage.local.get(POPUP_PREFS_KEY);
      await chrome.storage.local.set({
        [POPUP_PREFS_KEY]: {
          ...(prefs && typeof prefs === "object" ? prefs : {}),
          excludeMemoryIds: outputPrefs.excludeMemoryIds === true,
        },
      });
    } catch {
    }
    void savePopupPrefs();
    await refresh();
  })();
});

$("hyperlinksToggle")?.addEventListener("change", async () => {
  outputPrefs.hyperlinksEnabled = Boolean($("hyperlinksToggle")?.checked);
  applyHyperlinksToDom();
  await savePopupPrefs();
});

$("hyperlinkServiceArticleId")?.addEventListener("change", async () => {
  outputPrefs.hyperlinkServiceArticleId = normalizeHyperlinkService(
    $("hyperlinkServiceArticleId")?.value
  );
  applyHyperlinksToDom();
  await savePopupPrefs();
});

$("hyperlinkServiceShipment")?.addEventListener("change", async () => {
  outputPrefs.hyperlinkServiceShipment = normalizeHyperlinkService(
    $("hyperlinkServiceShipment")?.value
  );
  applyHyperlinksToDom();
  await savePopupPrefs();
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resetExtensionStateToFactory() {
  sourceState = { mode: "file", file: { text: "", fileName: "", fileNames: [], stats: null }, textInput: "" };
  outputPrefs = {
    priceThreshold: DEFAULT_PRICE_THRESHOLD,
    minPriceThreshold: DEFAULT_MIN_PRICE_THRESHOLD,
    vulnerableMinPriceThreshold: DEFAULT_VULNERABLE_MIN_PRICE_THRESHOLD,
    layoutGe: [],
    layoutLt: [],
    opsWarehouses: [""],
    threadsChoice: "auto",
    lastManualThreads: 5,
    uiGradient: true,
    aggressiveMode: false,
    excludeMemoryIds: false,
    hyperlinksEnabled: true,
    hyperlinkServiceArticleId: "hub",
    hyperlinkServiceShipment: "hub",
    vulnerabilityKeywords: [...DEFAULT_VULNERABILITY_KEYWORDS],
  };
  undoSourceSnapshot = null;
  undoJobSnapshot = null;
  modeUndoJobSnapshot = { file: null, text: null };
  clearedJobModes.clear();
  layoutDeletionHistory = [];
  modeWorkspaceState = {
    file: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
    text: { undoSourceSnapshot: null, hasJobUndo: false, layoutDeletionHistory: [], textInput: "" },
  };
  modeLastJobState = { file: null, text: null };
  void chrome.storage.local.remove([JOB_UNDO_KEY_FILE, JOB_UNDO_KEY_TEXT]);
  exportSourceDataMapKey = "";
  exportSourceDataMap = null;
  activeSourceTextCache = { mode: "", raw: null, value: "" };
  lastPersistedSource = { fileText: null, fileName: null, fileNamesKey: null, textInput: null };
  vulnerabilityKeywordMatcherCacheKey = "";
  vulnerabilityKeywordMatcherEntries = [];
  settingsPresets = [];
  selectedPresetId = "";
  renderPresetSelect();
  closeSecretKeywordsModal();
  setUndoEnabled("undoClearSource", false);
  setUndoEnabled("undoClearJob", false);
  resetLayoutDeletionButton();
}

function resetLayoutDeletionButton() {
  updateLayoutDeletedButton();
  const pop = $("layoutDeletedPopover");
  if (pop) {
    pop.hidden = true;
    pop.replaceChildren();
  }
  const btn = $("btnLayoutDeletedColumns");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

async function clearAllExtensionCache() {
  await chrome.storage.local.clear();
  if (globalThis.__goodsAuditCache) await globalThis.__goodsAuditCache.clearAllSourceCache();
  resetExtensionStateToFactory();
  $("sourceFile").value = "";
  $("sourceText").value = "";
  applyPopupSize(POPUP_SIZE_DEFAULT.w, POPUP_SIZE_DEFAULT.h);
  applyOutputPrefsToUi({ rebuildLayout: false, rebuildLists: false });
  toggleSourceModeUi();
  setSourceMeta();
  showSettingsPanel(false, { skipSave: true });
  await savePopupPrefs();
  await refresh();
  showAppToast("Кэш очищен. Расширение сброшено.", 3200);
}

$("btnClearAllCache")?.addEventListener("click", () => {
  void (async () => {
    const password = await askAppInput({
      title: "Очистить весь кэш",
      message: "Пароль для полного сброса. Всё сотрётся.",
      placeholder: "Пароль",
      okText: "Очистить",
      cancelText: "Отмена",
      inputType: "password",
    });
    if (password == null) return;
    const hash = await sha256Hex(password);
    if (hash !== CACHE_CLEAR_HASH) {
      showAppToast("Неверный пароль.", 3200);
      return;
    }
    await clearAllExtensionCache();
  })();
});

$("minPriceThreshold").addEventListener("input", () => {
  outputPrefs.minPriceThreshold = Math.max(0, Number($("minPriceThreshold").value) || 0);
  refreshCopyButtonsText();
  clearTimeout(priceThresholdDebounceTimer);
  priceThresholdDebounceTimer = setTimeout(() => {
    priceThresholdDebounceTimer = null;
    void (async () => {
      await savePopupPrefs();
      await refresh();
    })();
  }, 280);
});

$("vulnerableMinPriceThreshold")?.addEventListener("input", () => {
  outputPrefs.vulnerableMinPriceThreshold = Math.max(
    0,
    Number($("vulnerableMinPriceThreshold").value) || 0
  );
  refreshThresholdDependentLabels();
  clearTimeout(priceThresholdDebounceTimer);
  priceThresholdDebounceTimer = setTimeout(() => {
    priceThresholdDebounceTimer = null;
    void (async () => {
      await savePopupPrefs();
      await refresh();
    })();
  }, 280);
});

$("btnAddOpsWarehouse")?.addEventListener("click", async () => {
  const arr = getOpsWarehousesList({ keepEmpty: true });
  arr.push("");
  outputPrefs.opsWarehouses = arr;
  renderOpsWarehousesList();
  await savePopupPrefs();
});

$("btnAddSecretKeyword")?.addEventListener("click", async () => {
  const modal = $("secretKeywordsModal");
  if (!modal || modal.hidden) return;
  const arr = getVulnerabilityKeywordsList();
  arr.unshift("Новый кейворд");
  outputPrefs.vulnerabilityKeywords = arr;
  vulnerabilityKeywordMatcherCacheKey = "";
  secretKeywordsSearchQuery = "";
  const searchInput = $("secretKeywordsSearch");
  if (searchInput) searchInput.value = "";
  renderVulnerabilityKeywordsList("secretKeywordsList");
  focusFirstSecretKeywordInput();
  await savePopupPrefs();
});

$("secretKeywordsSearch")?.addEventListener("input", () => {
  secretKeywordsSearchQuery = String($("secretKeywordsSearch")?.value || "");
  renderVulnerabilityKeywordsList("secretKeywordsList");
});

$("presetSelect")?.addEventListener("change", () => {
  selectedPresetId = String($("presetSelect")?.value || "");
  renderPresetSelect();
  schedulePopupPrefsSave(150);
});

$("btnApplyPreset")?.addEventListener("click", () => void onApplyPresetClick());
$("btnSavePreset")?.addEventListener("click", () => void onSavePresetClick());
$("btnUpdatePreset")?.addEventListener("click", () => void onUpdatePresetClick());
$("btnDeletePreset")?.addEventListener("click", () => void onDeletePresetClick());

$("btnExportTableColumns")?.addEventListener("click", () => {
  exportTableColumnsToFile();
});

$("btnImportTableColumns")?.addEventListener("click", () => {
  $("tableColumnsImportFile")?.click();
});

$("tableColumnsImportFile")?.addEventListener("change", () => {
  const input = $("tableColumnsImportFile");
  const file = input?.files?.[0] || null;
  void (async () => {
    await importTableColumnsFromFile(file);
    if (input) input.value = "";
  })();
});

$("btnOpenSettings").addEventListener("click", (e) => {
  const clickCount = Number(e?.detail || 0);
  if (clickCount >= 3) {
    e.preventDefault();
    e.stopPropagation();
    void tryUnlockSecretSettings();
    return;
  }
  showSettingsPanel(Boolean($("panelSettings").hidden));
});

$("btnCloseSecretKeywords")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeSecretKeywordsModal();
});

$("secretKeywordsModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    closeSecretKeywordsModal();
  }
});

$("settingsTabGeneral")?.addEventListener("click", () => setSettingsTab("general"));
$("settingsTabLayout")?.addEventListener("click", () => setSettingsTab("layout"));

document.addEventListener(
  "dragover",
  (e) => {
    if (!layoutDragActive) return;
    e.preventDefault();
    updateLayoutDragAutoScroll(e.clientY);
  },
  true
);
document.addEventListener(
  "dragend",
  () => {
    if (layoutDragActive) stopLayoutDragAutoScroll();
  },
  true
);
document.addEventListener(
  "drop",
  () => {
    if (layoutDragActive) stopLayoutDragAutoScroll();
  },
  true
);

$("btnLayoutDeletedColumns")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (layoutDeletionHistory.length === 0) return;
  const pop = $("layoutDeletedPopover");
  const next = Boolean(pop?.hidden);
  setLayoutDeletedPopoverOpen(next);
});

$("layoutDeletedPopover")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (ev.target.closest(".layout-deleted-remove")) {
    const id = ev.target.closest(".layout-deleted-row")?.dataset?.id;
    if (id) void removeLayoutDeletionById(id);
    return;
  }
  if (ev.target.closest(".layout-deleted-clear-all")) {
    void clearAllLayoutDeletions();
    return;
  }
  const restore = ev.target.closest(".layout-deleted-restore");
  if (!restore) return;
  const id = restore.closest(".layout-deleted-row")?.dataset?.id;
  if (!id) return;
  void restoreLayoutDeletionById(id);
  setLayoutDeletedPopoverOpen(false);
});

document.addEventListener(
  "click",
  (ev) => {
    const wrap = $("layoutDeletedWrap");
    const pop = $("layoutDeletedPopover");
    if (!wrap || !pop || pop.hidden) return;
    if (!wrap.contains(ev.target)) setLayoutDeletedPopoverOpen(false);
  },
  true
);
$("brandLogo").addEventListener("click", () => {
  if (secretKeywordsModalOpen) {
    closeSecretKeywordsModal();
    return;
  }
  if ($("panelSettings") && !$("panelSettings").hidden) {
    showSettingsPanel(false);
    return;
  }
  onLogoTap();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (secretKeywordsModalOpen) {
    closeSecretKeywordsModal();
    return;
  }
  if ($("panelSettings").hidden) return;
  const pop = $("layoutDeletedPopover");
  if (pop && !pop.hidden) {
    setLayoutDeletedPopoverOpen(false);
    return;
  }
  showSettingsPanel(false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[JOB_KEY_FILE]) {
    if (clearedJobModes.has("file") && changes[JOB_KEY_FILE].newValue) return;
    scheduleStorageJobRender(changes[JOB_KEY_FILE].newValue || null);
  }
  if (changes[JOB_KEY_TEXT]) {
    if (clearedJobModes.has("text") && changes[JOB_KEY_TEXT].newValue) return;
    scheduleStorageJobRender(changes[JOB_KEY_TEXT].newValue || null);
  }
});

async function setSourceMode(nextMode) {
  if (nextMode !== "file" && nextMode !== "text") return;
  if (sourceState.mode === nextMode) return;
  syncCurrentModeWorkspaceFromGlobals();
  sourceState.mode = nextMode;
  applyModeWorkspaceToGlobals(nextMode);
  if (nextMode === "text") {
    sourceState.textInput = String(modeWorkspaceState.text?.textInput ?? sourceState.textInput ?? "");
    if ($("sourceText")) $("sourceText").value = sourceState.textInput;
    hideFileLoadProgress();
  }
  toggleSourceModeUi();
  setSourceMeta();
  refreshRunButtonOnly();
  
  render(await getJob());
  await savePopupPrefs();
}

$("sourceModeFileBtn")?.addEventListener("click", () => void setSourceMode("file"));
$("sourceModeTextBtn")?.addEventListener("click", () => void setSourceMode("text"));

$("sourceText").addEventListener("input", () => {
  sourceState.textInput = $("sourceText").value || "";
  setSourceMeta();
  refreshRunButtonOnly();
  // Полный разбор текста не делаем на каждый ввод: getActiveSourceExportData()
  // пересоберёт данные лениво, когда они реально понадобятся.
  invalidateExportSourceDataCache();
  scheduleLayoutPreviewRefresh();
  clearTimeout(textInputSaveTimer);
  textInputSaveTimer = setTimeout(() => void savePopupPrefs(), 280);
});

$("sourceText").addEventListener("paste", () => {
  setTimeout(() => {
    sourceState.textInput = $("sourceText").value || "";
    setSourceMeta();
    refreshRunButtonOnly();
    invalidateExportSourceDataCache();
    scheduleLayoutPreviewRefresh();
    void savePopupPrefs();
  }, 0);
});

let jobPollTimer = null;

function stopJobPoll() {
  if (jobPollTimer != null) {
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }
}

function startJobPollIfNeeded(job) {
  const active = job?.phase === "running" || job?.phase === "paused";
  if (!active) {
    stopJobPoll();
    return;
  }
  if (jobPollTimer != null) return;
  jobPollTimer = setInterval(() => {
    
    if (Date.now() - lastStorageJobRenderAt < 1200) return;
    void refresh();
  }, 1500);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopJobPoll();
    flushPendingUiSaveTimers();
    syncTextInputFromTextarea();
    void savePopupPrefs();
    return;
  }
  void refresh();
});

window.addEventListener("pagehide", () => {
  stopJobPoll();
  flushPendingUiSaveTimers();
  syncTextInputFromTextarea();
  void savePopupPrefs();
});

(async () => {
  try {
    
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 48));

    initPopupResize();
    initSourceFileDrop();
    const hadPrefs = await restorePopupPrefs();
    await loadSettingsPresets();
    renderPresetSelect();
    await restoreSourceFromCache();
    if (!hadPrefs) {
      applyPopupSize(POPUP_SIZE_DEFAULT.w, POPUP_SIZE_DEFAULT.h);
      applyUiGradientToDom();
      showSettingsPanel(false, { skipSave: true });
    }
    $("sourceText").value = sourceState.textInput || "";
    toggleSourceModeUi();
    setSourceMeta();
    updateLayoutDeletedButton();
    await refresh();
    startJobPollIfNeeded(lastJobState);
  } finally {
    // Короткая пауза, чтобы сплэш не мигал; долгие искусственные задержки убраны.
    const splashHoldMs = 320;
    await new Promise((r) => setTimeout(r, splashHoldMs));
    const splash = document.getElementById("bootSplash");
    
    document.documentElement.classList.remove("popup-booting");
    if (splash) {
      
      void splash.offsetWidth;
      splash.classList.add("is-leaving");
      await new Promise((r) => setTimeout(r, 340));
      splash.remove();
    }
  }
})();
