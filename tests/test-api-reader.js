// Тесты оркестратора чтения (api-reader.js) с полностью фейковым драйвером:
// разрешение типа, паритет с DOM по каждому типу, фолбэки, 401, отключение.
const assert = require("assert");
const M = require("../api-mapping.js");
const RT = require("../api-returns.js");
const R = require("../api-reader.js");

// --- фикстуры «бэкенда» ------------------------------------------------------

function postingInfo(id, over = {}) {
  return Object.assign(
    {
      lozonId: Number(id),
      number: "0136207144-0017-1",
      price: { value: 9877, currency: "RUB" },
      deliverySchema: "fbs",
      lozonState: "lost",
      formationWarehouseName: "FBS/2156699/Чагинская",
      currentWarehouseName: "МО_ИСТРА_ДО",
      contractCustomerName: "ИП Иванов",
      alpsStatus: null,
    },
    over
  );
}

const postingContent = { exemplars: [{ modelName: "Чехлы Автопилот HONDA CR-V" }] };

// Нормализация — копия normalizeArticleSnapshot из background.js (тот же контракт).
function normalize(raw, item) {
  const src = raw && typeof raw === "object" ? raw : {};
  const articleId = item?.articleId;
  const fallbackShipment = item?.shipmentSource || "";
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
  const hasPriceValue = src.price != null && src.price !== "" && Number.isFinite(priceNum);
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

// Фейковый драйвер: «бэкенд» по URL + DOM, который по умолчанию согласован с API.
function makeDriver(opts = {}) {
  const state = {
    domCalls: 0,
    replayCalls: 0,
    relearnCalls: 0,
    urls: [],
    logs: [],
    types: opts.types || {}, // articleId → articleType
    infos: opts.infos || {}, // articleId → info payload
    contents: opts.contents || {},
    carriages: opts.carriages || {}, // articleId → последняя перевозка
    status: opts.status || (() => 200),
    domOverride: opts.domOverride || null,
    opsWarehouses: opts.opsWarehouses || [],
  };

  const apiSnapshotFor = (id) => {
    const type = state.types[id] || "posting";
    if (!RT.isSupportedType(type)) return RT.mapUnsupported(id);
    const mapped = RT.mapByType(type, state.infos[id], state.contents[id]);
    if (mapped) return mapped;
    // Для объектов без фикстуры «страница» отдаёт пустую карточку.
    const empty = RT.emptySnapshot();
    empty.articleId = String(id);
    return empty;
  };

  const deps = {
    domScrape: async (item) => {
      state.domCalls += 1;
      // Загрузка страницы — самая долгая операция; в тестах на многопоточность
      // это позволяет запросам действительно пересечься во времени.
      if (opts.domDelayMs) await new Promise((r) => setTimeout(r, opts.domDelayMs));
      const id = String(item.articleId);
      const raw = apiSnapshotFor(id);
      let ops = M.resolveOpsWarehouse(raw.operationalWarehouse, state.opsWarehouses);
      // Так же, как настоящий скрейпер: не нашли наш склад в «Текущем месте» —
      // ищем его в блоке «Последняя перевозка».
      if (!ops.matched && state.opsWarehouses.length) {
        for (const place of RT.carriagePlaceNames(state.carriages[id])) {
          const hit = M.resolveOpsWarehouse(place, state.opsWarehouses);
          if (hit.matched) {
            ops = { matched: hit.matched, seen: true };
            break;
          }
        }
      }
      const withOps = Object.assign({}, raw, {
        operationalWarehouse: ops.matched,
        operationalWarehouseSeen: ops.seen,
      });
      const normalized = normalize(withOps, item);
      return state.domOverride ? state.domOverride(normalized, item) : normalized;
    },
    captureAndClear: async () => [
      {
        url: "https://returns.o3t.ru/p-api/alps-api/v1/ArticleProfile/Posting/info?id=1",
        method: "GET",
        status: 200,
        headers: { authorization: "Bearer T1", "x-o3-app-name": "alps-client" },
        responseText: "{}",
      },
    ],
    replay: async (req) => {
      state.replayCalls += 1;
      state.urls.push(req.url);
      const st = state.status(req.url, state.replayCalls);
      if (st !== 200) return { status: st, body: null };
      const typeMatch = req.url.match(/get-article-type\?article=(.+)$/);
      if (typeMatch) {
        const id = decodeURIComponent(typeMatch[1]);
        return { status: 200, body: { articleId: Number(id) || id, articleType: state.types[id] || "posting" } };
      }
      const infoMatch = req.url.match(/\/(Posting|Exemplar|TransitBox)\/info\?id=(\d+)/);
      if (infoMatch) return { status: 200, body: state.infos[infoMatch[2]] };
      const carriageMatch = req.url.match(/last-carriage\/(\d+)/);
      if (carriageMatch) return { status: 200, body: state.carriages[carriageMatch[1]] || null };
      const contentMatch = req.url.match(/(posting-content|TransitBox\/content)\/(\d+)/);
      if (contentMatch) return { status: 200, body: state.contents[contentMatch[2]] || { exemplars: [] } };
      return { status: 404, body: null };
    },
    normalize,
    relearnToken: async () => {
      state.relearnCalls += 1;
    },
    isOnHubDomain: async () => true,
    log: (m) => state.logs.push(m),
  };
  return { state, deps };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("posting: одна сверка с DOM → тип включается, дальше только API", async () => {
  const ids = ["501883634205001", "501883634205002", "501883634205003"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  const { state, deps } = makeDriver({ infos, contents });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });

  const r1 = await reader.read({ articleId: ids[0] });
  assert.strictEqual(r1.path, "dom", "первая сверка — данные со страницы");
  assert.strictEqual(reader.getPhase("posting"), "on", "тип подтверждён одной сверкой");

  const domCallsBefore = state.domCalls;
  const r2 = await reader.read({ articleId: ids[1] });
  const r3 = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r2.path, "api", "дальше читаем через API");
  assert.strictEqual(r3.path, "api");
  assert.strictEqual(state.domCalls, domCallsBefore, "страница больше не открывается");
  assert.strictEqual(r3.data.price, 9877);
  assert.strictEqual(r3.data.statusLozon, "Недостача");
  assert.strictEqual(r3.data.deliveryScheme, "FBS");
});

test("паритет: API-данные совпадают с DOM поле в поле", async () => {
  const id = "501883634205010";
  const infos = { [id]: postingInfo(id) };
  const contents = { [id]: postingContent };
  const { deps } = makeDriver({ infos, contents });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: id });
  await reader.read({ articleId: id });
  const api = await reader.read({ articleId: id });
  assert.strictEqual(api.path, "api");
  const dom = await deps.domScrape({ articleId: id });
  for (const f of M.SCRAPE_FIELDS) {
    assert.deepStrictEqual(api.data[f], dom[f], "поле " + f);
  }
  assert.strictEqual(api.data.unsupportedTransitBox, dom.unsupportedTransitBox);
});

test("неподдерживаемый тип: закрывается без открытия страницы", async () => {
  const ids = ["900000000001", "900000000002", "900000000003"];
  const types = {};
  ids.forEach((id) => (types[id] = "pallet"));
  const { state, deps } = makeDriver({ types });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: ids[0] });
  assert.strictEqual(reader.getPhase("unsupported"), "on");
  const before = state.domCalls;
  const r = await reader.read({ articleId: ids[1] });
  assert.strictEqual(r.path, "api");
  assert.strictEqual(state.domCalls, before, "страница не открывалась");
  assert.strictEqual(r.data.unsupportedTransitBox, true);
});

test("неподдерживаемые типы идут одним каналом: подтверждение общее", async () => {
  // Профиль карточки рисует «Неподдерживаемый тип» всему, что вне трёх типов,
  // поэтому механизм один — проверять его на каждый тип отдельно значит
  // впустую грузить страницы.
  const palletId = "900000001001";
  const sackId = "900000002001";
  const boxId = "900000003001";
  const types = { [palletId]: "pallet", [sackId]: "sack", [boxId]: "boxTare" };
  const { state, deps } = makeDriver({ types });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  const first = await reader.read({ articleId: palletId });
  assert.strictEqual(first.path, "dom", "первая сверка со страницей");
  assert.strictEqual(reader.getPhase("unsupported"), "on");

  const before = state.domCalls;
  const r1 = await reader.read({ articleId: sackId });
  const r2 = await reader.read({ articleId: boxId });
  assert.strictEqual(r1.path, "api", "другой неподдерживаемый тип уже без страницы");
  assert.strictEqual(r2.path, "api");
  assert.strictEqual(state.domCalls, before, "лишних загрузок страницы нет");
  assert.strictEqual(r1.data.unsupportedTransitBox, true);
});

test("сломанная ручка деталей отключает тип, а не крутится вечно", async () => {
  const ids = ["501883634205070", "501883634205071", "501883634205072"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  const { state, deps } = makeDriver({
    infos,
    contents,
    status: (url) => (url.includes("/Posting/info") ? 500 : 200),
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, maxProbeFails: 2 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  assert.strictEqual(reader.getPhase("posting"), "off", "тип отключён после сбоев");
  const before = state.replayCalls;
  const r = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r.path, "dom");
  assert.ok(state.replayCalls - before <= 1, "к сломанной ручке больше не ходим");
});

test("расхождение с DOM на probe → тип уходит в off и читается страницей", async () => {
  const ids = ["501883634205020", "501883634205021", "501883634205022"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  // DOM «показывает» другую цену → паритета нет.
  const { state, deps } = makeDriver({
    infos,
    contents,
    domOverride: (snap) => Object.assign({}, snap, { price: snap.price + 100 }),
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, maxProbeFails: 2 });
  const r1 = await reader.read({ articleId: ids[0] });
  assert.strictEqual(r1.path, "dom");
  await reader.read({ articleId: ids[1] });
  assert.strictEqual(reader.getPhase("posting"), "off", "тип отключён после 2 расхождений");
  const replaysBefore = state.replayCalls;
  const r3 = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r3.path, "dom");
  // Отключённый тип не тратит запросы на детали (только разрешение типа).
  assert.ok(state.replayCalls - replaysBefore <= 1, "лишних запросов нет");
});

test("разные типы независимы: сломанный exemplar не выключает posting", async () => {
  const pIds = ["501883634205030", "501883634205031", "501883634205032"];
  const eIds = ["701883311344001", "701883311344002"];
  const types = {};
  const infos = {};
  const contents = {};
  pIds.forEach((id) => {
    types[id] = "posting";
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  eIds.forEach((id) => {
    types[id] = "exemplar";
    infos[id] = {
      exemplarId: Number(id),
      modelName: "Экземпляр",
      deliverySchema: "fbo",
      lozonExemplarState: "taken",
      currentWarehouseName: "МО_ИСТРА_ХАБ",
    };
  });
  const { deps } = makeDriver({
    types,
    infos,
    contents,
    // У экземпляров DOM «находит» номер отправления, которого нет в API.
    domOverride: (snap, item) =>
      String(item.articleId).startsWith("7018")
        ? Object.assign({}, snap, { shipment: "0179-1111111-1" })
        : snap,
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: eIds[0] });
  await reader.read({ articleId: eIds[1] });
  assert.strictEqual(reader.getPhase("exemplar"), "off", "экземпляры ушли в фолбэк");

  await reader.read({ articleId: pIds[0] });
  await reader.read({ articleId: pIds[1] });
  assert.strictEqual(reader.getPhase("posting"), "on", "отправления работают через API");
  const r = await reader.read({ articleId: pIds[2] });
  assert.strictEqual(r.path, "api");
});

test("401 в режиме on → переучивание и возврат к API", async () => {
  const ids = ["501883634205040", "501883634205041", "501883634205042"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  let fired = false;
  const { state, deps } = makeDriver({
    infos,
    contents,
    status: (url) => {
      if (!fired && url.includes("Posting/info?id=" + ids[2])) {
        fired = true;
        return 401;
      }
      return 200;
    },
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const r = await reader.read({ articleId: ids[2] });
  assert.strictEqual(state.relearnCalls >= 1, true, "было переучивание сессии");
  assert.strictEqual(r.path, "api", "после переучивания снова API");
});

test("не удалось определить тип → полностью уходим на страницы", async () => {
  const { state, deps } = makeDriver({ status: () => 500 });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, maxProbeFails: 2 });
  const r1 = await reader.read({ articleId: "1000000000001" });
  assert.strictEqual(r1.path, "dom");
  await reader.read({ articleId: "1000000000002" });
  const before = state.replayCalls;
  const r3 = await reader.read({ articleId: "1000000000003" });
  assert.strictEqual(r3.path, "dom");
  assert.strictEqual(state.replayCalls, before, "запросы к API прекращены");
});

test("фильтр опер. складов: чужой склад пустеет, seen остаётся true", async () => {
  const ids = ["501883634205050", "501883634205051", "501883634205052"];
  const infos = {
    [ids[0]]: postingInfo(ids[0], { currentWarehouseName: "МО_ИСТРА_ДО" }),
    [ids[1]]: postingInfo(ids[1], { currentWarehouseName: "МО_ИСТРА_ДО" }),
    [ids[2]]: postingInfo(ids[2], { currentWarehouseName: "ЧУЖОЙ_СКЛАД" }),
  };
  const contents = {};
  ids.forEach((id) => (contents[id] = postingContent));
  const { deps } = makeDriver({ infos, contents, opsWarehouses: ["МО_ИСТРА_ДО"] });
  const reader = R.createHubApiReader(deps, {
    verifyEveryN: 0,
    opsWarehouses: ["МО_ИСТРА_ДО"],
  });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const r = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r.path, "api");
  assert.strictEqual(r.data.operationalWarehouse, "", "чужой склад → пусто, как в DOM");
  assert.strictEqual(r.data.operationalWarehouseSeen, true, "склад на карточке был");
});

test("общее состояние: второй поток не пробуется заново и статистика общая", async () => {
  const ids = ["501883634205700", "501883634205701", "501883634205702", "501883634205703"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  const shared = {
    sharedChannels: new Map(),
    sharedCounters: new Map(),
    sharedDiagnostics: new Map(),
    sharedFallbacks: new Map(),
    sharedTypeCache: new Map(),
  };
  const a = makeDriver({ infos, contents });
  const b = makeDriver({ infos, contents });
  const readerA = R.createHubApiReader(a.deps, { verifyEveryN: 0, ...shared });
  const readerB = R.createHubApiReader(b.deps, { verifyEveryN: 0, ...shared });

  // Первый поток проходит пробу...
  await readerA.read({ articleId: ids[0] });
  assert.strictEqual(readerA.getPhase("posting"), "on");
  // ...а второй сразу читает через API, не открывая страницу заново.
  assert.strictEqual(readerB.getPhase("posting"), "on", "состояние общее");
  const domBefore = b.state.domCalls;
  const r = await readerB.read({ articleId: ids[2] });
  assert.strictEqual(r.path, "api");
  assert.strictEqual(b.state.domCalls, domBefore, "второй поток не пробуется заново");

  // Статистика причин тоже общая, а не перезаписывается.
  const summary = readerB.fallbackSummary();
  const total = summary.reduce((acc, x) => acc + x.count, 0);
  assert.strictEqual(total, 1, "учтена проба первого потока: " + JSON.stringify(summary));
});

test("ни один уход на страницу не остаётся без причины", async () => {
  const ids = ["501883634205500", "501883634205501", "501883634205502"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    // Статус, которого нет во встроенном словаре, — молчаливый путь из прошлой версии.
    infos[id] = postingInfo(id, { lozonState: "someBrandNewState" });
    contents[id] = postingContent;
  });
  const { deps } = makeDriver({ infos, contents });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  for (const id of ids) {
    const r = await reader.read({ articleId: id });
    assert.strictEqual(r.path, "dom");
  }
  const summary = reader.fallbackSummary();
  assert.ok(summary.length > 0, "причины зафиксированы");
  const total = summary.reduce((acc, x) => acc + x.count, 0);
  assert.strictEqual(total, ids.length, "учтён каждый объект");
  assert.ok(
    summary.some((x) => x.reason.includes("неизвестный код")),
    "причина названа явно: " + JSON.stringify(summary)
  );
});

test("неизвестный код: подпись выучивается со страницы и API включается", async () => {
  const ids = ["501883634205600", "501883634205601", "501883634205602", "501883634205603"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id, { lozonState: "freshBackendState" });
    contents[id] = postingContent;
  });
  // Страница показывает человеческую подпись нового кода.
  const { deps } = makeDriver({
    infos,
    contents,
    domOverride: (snap) => Object.assign({}, snap, { statusLozon: "Новый статус", status: "Новый статус" }),
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  const first = await reader.read({ articleId: ids[0] });
  assert.strictEqual(first.path, "dom", "первый объект читается страницей");
  // Дальше код уже известен: идут обычные пробы, затем API.
  await reader.read({ articleId: ids[1] });
  await reader.read({ articleId: ids[2] });
  const r = await reader.read({ articleId: ids[3] });
  assert.strictEqual(r.path, "api", "после обучения читаем через API");
  assert.strictEqual(r.data.statusLozon, "Новый статус", "подпись взята со страницы");
});

test("диагностика: причина отключения содержит поле и оба значения", async () => {
  const ids = ["501883634205400", "501883634205401"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  // Страница «показывает» другой статус, чем даёт API.
  const { deps } = makeDriver({
    infos,
    contents,
    domOverride: (snap) => Object.assign({}, snap, { status: "Активный" }),
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, maxProbeFails: 2 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const diag = reader.snapshot();
  assert.strictEqual(diag.posting.phase, "off");
  assert.ok(diag.posting.mismatches.includes("status"), "поле расхождения записано");
  const sample = diag.posting.samples.find((s) => s.field === "status");
  assert.strictEqual(sample.api, "Недостача");
  assert.strictEqual(sample.dom, "Активный");
});

test("периодическая сверка: каждый N-й объект перепроверяется страницей", async () => {
  const ids = [];
  const infos = {};
  const contents = {};
  for (let i = 1; i <= 8; i++) {
    const id = "50188363420520" + i;
    ids.push(id);
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  }
  const { state, deps } = makeDriver({ infos, contents });
  // Сверяем каждый третий объект канала.
  const reader = R.createHubApiReader(deps, { verifyEveryN: 3 });
  const paths = [];
  for (const id of ids) {
    const r = await reader.read({ articleId: id });
    paths.push(r.path);
  }
  assert.strictEqual(paths[0], "dom", "одна стартовая проба");
  assert.strictEqual(reader.getPhase("posting"), "on");
  assert.ok(paths.slice(1).includes("api"), "основная масса читается через API");
  const verifyReads = paths.slice(1).filter((p) => p === "dom").length;
  assert.ok(verifyReads >= 1, "контрольные сверки со страницей происходят");
  assert.ok(verifyReads < paths.length - 1, "но это не каждый объект");
});

test("постоянный 401 на пробах не крутит переучивание бесконечно", async () => {
  const ids = ["501883634205300", "501883634205301", "501883634205302"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  const { state, deps } = makeDriver({ infos, contents, status: () => 401 });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, maxProbeFails: 2 });
  for (const id of ids) {
    const r = await reader.read({ articleId: id });
    assert.strictEqual(r.path, "dom");
  }
  await reader.read({ articleId: ids[0] });
  assert.strictEqual(reader.getPhase("resolve"), "off", "разрешение типа отключено");
  assert.ok(state.relearnCalls <= 3, "переучивание не повторяется на каждый объект");
});

test("объект «в пути»: наш склад находится в последней перевозке, как в DOM", async () => {
  // Текущее место — чужой склад, но последняя перевозка идёт к нам: страница
  // такой объект относит к нашему складу, значит и API обязан.
  const ids = ["501883634205800", "501883634205801", "501883634205802"];
  const infos = {};
  const contents = {};
  const carriages = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id, { currentWarehouseName: "ЛЮБЛИНО_АППЗ_1" });
    contents[id] = postingContent;
    carriages[id] = {
      sourcePlaceName: "ЛЮБЛИНО_АППЗ_1",
      destinationPlaceName: "МО_ИСТРА_ДО",
      isCompleted: false,
    };
  });
  const ops = ["МО_ИСТРА_ДО"];
  const { deps } = makeDriver({ infos, contents, carriages, opsWarehouses: ops });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, opsWarehouses: ops });

  const probe = await reader.read({ articleId: ids[0] });
  assert.strictEqual(probe.path, "dom");
  assert.strictEqual(reader.getPhase("posting"), "on", "сверка сошлась, тип включён");

  const r = await reader.read({ articleId: ids[1] });
  assert.strictEqual(r.path, "api");
  assert.strictEqual(r.data.operationalWarehouse, "МО_ИСТРА_ДО", "склад взят из перевозки");
  assert.strictEqual(r.data.operationalWarehouseSeen, true);
});

test("перевозка не запрашивается, когда текущее место и так наше", async () => {
  const ids = ["501883634205900", "501883634205901"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id, { currentWarehouseName: "МО_ИСТРА_ДО" });
    contents[id] = postingContent;
  });
  const ops = ["МО_ИСТРА_ДО"];
  const { state, deps } = makeDriver({ infos, contents, opsWarehouses: ops });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0, opsWarehouses: ops });
  await reader.read({ articleId: ids[0] });
  state.urls.length = 0;
  await reader.read({ articleId: ids[1] });
  assert.ok(
    !state.urls.some((u) => u.includes("last-carriage")),
    "лишнего запроса нет: " + JSON.stringify(state.urls)
  );
});

test("неизвестный код статуса → объект читается страницей, тип не ломается", async () => {
  const ids = ["501883634205060", "501883634205061", "501883634205062"];
  const infos = {};
  const contents = {};
  ids.forEach((id) => {
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  });
  infos[ids[2]] = postingInfo(ids[2], { lozonState: "brandNewStateFromBackend" });
  const { state, deps } = makeDriver({ infos, contents });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  assert.strictEqual(reader.getPhase("posting"), "on");
  const before = state.domCalls;
  const r = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r.path, "dom", "неизвестный код → страница");
  assert.strictEqual(state.domCalls, before + 1);
  assert.strictEqual(reader.getPhase("posting"), "on", "тип остаётся включённым");
});

// --- многопоточность: страница не должна открываться по разу на каждый поток --

function postingBatch(prefix, count) {
  const ids = [];
  const infos = {};
  const contents = {};
  for (let i = 1; i <= count; i++) {
    const id = prefix + String(i).padStart(2, "0");
    ids.push(id);
    infos[id] = postingInfo(id);
    contents[id] = postingContent;
  }
  return { ids, infos, contents };
}

test("стартовая проба одна на тип, сколько бы потоков ни зашло разом", async () => {
  const { ids, infos, contents } = postingBatch("5018836342070", 5);
  const { state, deps } = makeDriver({ infos, contents, domDelayMs: 5 });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });

  // Все потоки стартуют одновременно и видят тип ещё непроверенным.
  const results = await Promise.all(ids.map((id) => reader.read({ articleId: id })));

  assert.strictEqual(state.domCalls, 1, "страницу открыл только тот, кто взял пробу");
  assert.strictEqual(reader.getPhase("posting"), "on");
  const viaApi = results.filter((r) => r.path === "api").length;
  assert.strictEqual(viaApi, ids.length - 1, "остальные дождались пробы и пошли через API");
});

test("контрольную сверку назначает себе один поток, а не все сразу", async () => {
  const { ids, infos, contents } = postingBatch("5018836342080", 9);
  const { state, deps } = makeDriver({ infos, contents, domDelayMs: 5 });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 3 });

  // Проба + два объекта: счётчик канала доходит до 3 — как раз до сверки.
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  await reader.read({ articleId: ids[2] });
  assert.strictEqual(reader.getPhase("posting"), "on");

  // Шесть потоков заходят в один момент. Номера 4..9 разберутся без пересечений,
  // и сверка достанется ровно одному — тому, кому выпал девятый.
  const before = state.domCalls;
  await Promise.all(ids.slice(3).map((id) => reader.read({ articleId: id })));
  assert.strictEqual(
    state.domCalls - before,
    1,
    "одна сверка на шесть потоков, а не по одной на каждый"
  );
});

test("шаг контрольной сверки растёт: сначала часто, дальше реже", async () => {
  const { ids, infos, contents } = postingBatch("5018836342090", 30);
  const { state, deps } = makeDriver({ infos, contents });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 2, maxVerifyEveryN: 8 });

  const domAt = [];
  for (let i = 0; i < ids.length; i++) {
    const before = state.domCalls;
    await reader.read({ articleId: ids[i] });
    if (state.domCalls > before) domAt.push(i + 1);
  }
  // 1 — стартовая проба, дальше шаг 2, 4, 8, 8, 8 (потолок).
  assert.deepStrictEqual(domAt, [1, 2, 6, 14, 22, 30]);
});

test("транзитная коробка: номенклатура как на странице, состав не запрашиваем", async () => {
  const id = "851348957478001";
  const { state, deps } = makeDriver({
    types: { [id]: "boxTransit" },
    infos: {
      [id]: {
        id: Number(id),
        mainInfo: {
          returnInventoryId: "RI-42",
          deliverySchema: "fbo",
          price: { value: 12000, currency: "RUB" },
          sellerInfo: { id: 7, name: "ООО Селлер" },
        },
        placeInfo: { currentPlace: { name: "МО_ИСТРА_ХАБ" }, sourcePlace: { name: "СЦ Софьино" } },
        statuses: { lozonState: "banded", returnStatus: "utilization" },
      },
    },
    // Состав у коробки есть, но страница показывает не его.
    contents: { [id]: { exemplars: [{ modelName: "Шкаф для одежды распашной 2113" }] } },
  });
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });

  const probe = await reader.read({ articleId: id });
  assert.strictEqual(probe.data.nomenclature, "Транзитная коробка");
  assert.strictEqual(
    reader.getPhase("boxTransit"),
    "on",
    "сверка со страницей сходится — тип включается"
  );
  assert.ok(
    !state.urls.some((u) => u.includes("/content/")),
    "лишнего запроса состава коробки нет"
  );
});

module.exports = { tests };
