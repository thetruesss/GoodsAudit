// Прогон рабочего цикла целиком, на заглушках chrome.*: background.js грузится
// в vm вместе с настоящими модулями чтения. Это единственный способ проверить
// сам цикл — сколько вкладок он открывает, сколько раз ходит на страницу и
// доводит ли задачу до конца. Зависимостей не требует.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");

function build({ apiWorks, items }) {
  const state = { tabs: new Map(), maxTabs: 0, nextId: 1, navigations: 0, apiCalls: 0, windows: new Set() };
  const cb = (fn, v) => setTimeout(() => fn(v), 0);

  const makeTab = (windowId, url = "about:blank") => {
    const id = state.nextId++;
    state.tabs.set(id, { id, windowId, url, index: state.tabs.size, discarded: false, status: "complete" });
    state.maxTabs = Math.max(state.maxTabs, state.tabs.size);
    return state.tabs.get(id);
  };

  const chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: "test" }), onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, id: "x" },
    alarms: { create() {}, clear(_n, c) { c && c(true); }, onAlarm: { addListener() {} }, getAll(c) { c([]); } },
    notifications: { create() {}, onClicked: { addListener() {} } },
    offscreen: { createDocument: async () => {}, hasDocument: async () => false },
    action: { onClicked: { addListener() {} } },
    windows: {
      create(opts, c) { const w = { id: 9000 + state.windows.size }; state.windows.add(w.id); makeTab(w.id); cb(c, w); },
      remove(id, c) { for (const [tid, t] of state.tabs) if (t.windowId === id) state.tabs.delete(tid); state.windows.delete(id); cb(c); },
      update(_id, _o, c) { cb(c, {}); },
      get(id, _o, c) { const f = typeof _o === "function" ? _o : c; cb(f, { id }); },
      onRemoved: { addListener() {} },
    },
    tabs: {
      create(opts, c) { cb(c, makeTab(opts.windowId, opts.url)); },
      remove(id, c) { state.tabs.delete(id); cb(c); },
      query(q, c) { cb(c, [...state.tabs.values()].filter((t) => t.windowId === q.windowId)); },
      get(id, c) { const t = state.tabs.get(id); if (!t) { chrome.runtime.lastError = { message: "No tab with id" }; cb(c, undefined); setTimeout(() => (chrome.runtime.lastError = null), 0); return; } cb(c, t); },
      update(id, props, c) {
        const t = state.tabs.get(id);
        if (t && props.url) { t.url = props.url; state.navigations += 1; }
        cb(c, t);
      },
      reload(_id, _o, c) { cb(c); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    scripting: {
      executeScript(opts, c) {
        state.apiCalls += opts.world === "MAIN" ? 1 : 0;
        const tab = state.tabs.get(opts.target.tabId);
        if (!tab) { chrome.runtime.lastError = { message: "No tab with id" }; cb(c, undefined); setTimeout(() => (chrome.runtime.lastError = null), 0); return; }
        if (opts.files) return cb(c, [{ result: null }]);
        const src = String(opts.func || "");
        // перехват заголовков
        if (src.includes("__gaCapturedRequests")) {
          return cb(c, [{ result: [{ url: "https://returns.o3t.ru/p-api/x", method: "GET", status: 200, headers: { authorization: "Bearer T" } }] }]);
        }
        // маркеры данных
        if (src.includes("Упаковка отправления")) return cb(c, [{ result: true }]);
        // чтение страницы
        if (src.includes("__returnsReadPage")) {
          const id = String(tab.url).split("/").pop();
          return cb(c, [{ result: snapshotFor(decodeURIComponent(id)) }]);
        }
        // fetch к API из контекста страницы
        if (src.includes("fetch(request.url")) {
          const req = opts.args[0];
          if (!apiWorks) return cb(c, [{ result: { status: 500, body: null } }]);
          return cb(c, [{ result: apiRespond(req.url) }]);
        }
        return cb(c, [{ result: null }]);
      },
    },
    storage: {
      local: (() => {
        const st = {};
        const keys = (k) => (k == null ? Object.keys(st) : typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k));
        return {
          get: async (k) => { const o = {}; for (const key of keys(k)) if (key in st) o[key] = st[key]; return o; },
          set: async (o) => { Object.assign(st, JSON.parse(JSON.stringify(o))); },
          remove: async (k) => { for (const key of keys(k)) delete st[key]; },
          clear: async () => { for (const key of Object.keys(st)) delete st[key]; },
        };
      })(),
      onChanged: { addListener() {} },
    },
  };

  const snapshotFor = (id) => ({
    price: 1000, nomenclature: "Товар " + id, shipment: id, articleId: numericId(id),
    isTransitBox: false, isC2C: false, unsupportedTransitBox: false,
    operationalWarehouse: "МО_ИСТРА_ХАБ", operationalWarehouseSeen: true,
    deliveryScheme: "FBS", formationWarehouse: "СЦ Софьино", owner: "ООО Ромашка",
    status: "Недостача", statusLozon: "Недостача", statusAlps: "",
  });
  const numericId = (id) => String(10000000000 + (Number(String(id).replace(/\D/g, "").slice(-6)) || 0));

  function apiRespond(url) {
    const idFromQuery = (url.match(/[?&]id=(\d+)/) || [])[1];
    const idFromPath = (url.match(/\/(\d+)$/) || [])[1];
    if (url.includes("get-article-type")) {
      const raw = decodeURIComponent((url.match(/article=([^&]+)/) || [])[1] || "");
      return { status: 200, body: { articleId: Number(numericId(raw)), articleType: "posting" } };
    }
    if (url.includes("/Posting/info")) {
      return { status: 200, body: {
        lozonId: Number(idFromQuery), number: reverse(idFromQuery), price: { value: 1000, currency: "RUB" },
        deliverySchema: "fbs", lozonState: "lost", formationWarehouseName: "СЦ Софьино",
        currentWarehouseName: "МО_ИСТРА_ХАБ", contractCustomerName: "ООО Ромашка", alpsStatus: null } };
    }
    if (url.includes("posting-content")) return { status: 200, body: { exemplars: [{ modelName: "Товар " + reverse(idFromPath) }] } };
    if (url.includes("last-carriage")) return { status: 200, body: null };
    return { status: 404, body: null };
  }
  const idMap = new Map();
  const reverse = (num) => idMap.get(String(num)) || String(num);
  for (const it of items) idMap.set(numericId(it), it);

  return { chrome, state };
}

async function run({ apiWorks, count, onCtx }) {
  const items = Array.from({ length: count }, (_, i) => "0136207144-00" + String(i + 10));
  const { chrome, state } = build({ apiWorks, items });
  // Логи прогона в тестах не нужны — ошибки всё равно всплывут через assert.
  const quietConsole = Object.assign({}, console, { log: () => {}, warn: () => {} });
  const sandbox = {
    chrome, console: quietConsole, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
    Date, Math, JSON, Promise, Map, Set, WeakMap, Array, Object, String, Number, Boolean, Error, RegExp, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, URL,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(ROOT + "/" + f, "utf8"), ctx, { filename: f });
  };
  const ctx = vm.createContext(sandbox);
  if (onCtx) onCtx(ctx);
  vm.runInContext(fs.readFileSync(ROOT + "/background.js", "utf8"), ctx, { filename: "background.js" });

  const payload = {
    sourceMode: "text",
    sourceName: "тест",
    aggressiveMode: false,
    toFetch: items.map((id) => ({ articleId: id, warehouse: "", operationalWarehouse: "", shipmentSource: "" })),
    skippedMem: [],
    skippedDupSource: [],
    inputStats: {},
    opsWarehouses: ["МО_ИСТРА_ХАБ"],
    skippedOpsWarehouse: [],
    initialResults: [],
    initialErrors: [],
    initialToFetchTotal: items.length,
    manualThreads: 6,
  };
  let runError = null;
  ctx.__resolveRun = () => {};
  ctx.__rejectRun = (e) => (runError = e);
  ctx.__payload = payload;
  vm.runInContext(
    `(async () => { try { await runJobFromState(__payload); __resolveRun(); } catch (e) { __rejectRun(e); } })();`,
    ctx
  );
  // Ждём завершения самой задачи: уборка окон после неё висит на заглушках,
  // а нас интересует именно прогон.
  const deadline = Date.now() + 60000;
  for (;;) {
    if (runError) throw runError;
    const snap = await ctx.chrome.storage.local.get(null);
    const k = Object.keys(snap).find((x) => snap[x] && snap[x].readStats);
    const j = k ? snap[k] : null;
    if (j && (j.phase === "done" || j.phase === "aborted")) break;
    if (Date.now() > deadline) throw new Error("прогон не завершился за 60с");
    await new Promise((r) => setTimeout(r, 50));
  }
  const all = await ctx.chrome.storage.local.get(null);
  const key = Object.keys(all).find((k) => all[k] && all[k].readStats);
  return { state, job: key ? all[key] : null, all };
}

module.exports = { run };
