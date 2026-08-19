// Тесты оркестратора чтения (api-reader.js) с полностью фейковым драйвером.
const assert = require("assert");
const M = require("../api-mapping.js");
const R = require("../api-reader.js");

const RESP = (id, snap) => ({
  records: [
    {
      articleId: id,
      shipment: snap.shipment,
      price: snap.price,
      item: { name: snap.nomenclature },
      place: { warehouse: { name: snap.operationalWarehouse } },
      delivery: { scheme: snap.deliveryScheme },
      formation: { warehouse: snap.formationWarehouse },
      owner: { title: snap.owner },
      statuses: { lozon: snap.statusLozon, alps: snap.statusAlps, active: snap.status },
    },
  ],
});

function makeSnap(id, n) {
  return {
    price: 1000 + n,
    nomenclature: "Товар " + n,
    shipment: "0179-000" + n + "-1",
    articleId: id,
    operationalWarehouse: "СКЛАД_" + n,
    deliveryScheme: "FBO",
    formationWarehouse: "СЦ " + n,
    owner: "ООО " + n,
    status: "Активен",
    statusLozon: "На складе",
    statusAlps: "Готов",
  };
}

function domDataFromSnap(snap) {
  return Object.assign({}, snap, { operationalWarehouseSeen: true, unsupportedTransitBox: false });
}

// Фейковый драйвер: считает вызовы, эмулирует захват заголовков и API-ответы.
function makeDriver(opts = {}) {
  const state = {
    domCalls: 0,
    replayCalls: 0,
    captureCalls: 0,
    relearnCalls: 0,
    snaps: opts.snaps || {},
    apiStatus: opts.apiStatus || (() => 200),
    logs: [],
    onDomain: opts.onDomain !== false,
  };
  const deps = {
    domScrape: async (item) => {
      state.domCalls += 1;
      return domDataFromSnap(state.snaps[item.articleId]);
    },
    captureAndClear: async () => {
      state.captureCalls += 1;
      // Отдаём одну запись с валидным авторизационным заголовком и «живым» ответом,
      // чтобы обучение нашло ручку.
      const id = opts.learnId;
      if (!id) return [];
      return [
        {
          url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
          method: "POST",
          status: 200,
          headers: { authorization: "Bearer T1", "x-o3-app-name": "scms" },
          body: JSON.stringify({ id }),
          responseText: JSON.stringify(RESP(id, state.snaps[id])),
        },
      ];
    },
    replay: async (req, headers) => {
      state.replayCalls += 1;
      const id = (req.url.match(/articles\/(\d+)\//) || [])[1];
      const status = state.apiStatus(id, state.replayCalls);
      if (status !== 200) return { status, body: null };
      return { status: 200, body: RESP(id, state.snaps[id]) };
    },
    relearnToken: async () => {
      state.relearnCalls += 1;
      state.onDomain = true;
    },
    isOnHubDomain: async () => state.onDomain,
    log: (m) => state.logs.push(m),
  };
  return { state, deps };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("probe(2) → on, дальше только API", async () => {
  const ids = ["100000000001", "100000000002", "100000000003", "100000000004"];
  const snaps = {};
  ids.forEach((id, i) => (snaps[id] = makeSnap(id, i + 1)));
  const { state, deps } = makeDriver({ snaps, learnId: ids[0] });
  // Захват должен вернуть ручку текущего объекта на каждом probe-шаге:
  deps.captureAndClear = (function () {
    let call = 0;
    return async () => {
      const id = ids[call++];
      return [
        {
          url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
          method: "POST",
          status: 200,
          headers: { authorization: "Bearer T1", "x-o3-app-name": "scms" },
          body: JSON.stringify({ id }),
          responseText: JSON.stringify(RESP(id, snaps[id])),
        },
      ];
    };
  })();

  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  const r1 = await reader.read({ articleId: ids[0] });
  assert.strictEqual(r1.path, "dom");
  const r2 = await reader.read({ articleId: ids[1] });
  assert.strictEqual(r2.path, "dom");
  assert.strictEqual(reader.getPhase(), "on", "включились после 2 проб");
  const r3 = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r3.path, "api");
  assert.strictEqual(r3.data.operationalWarehouseSeen, true);
  for (const f of M.SCRAPE_FIELDS) {
    assert.deepStrictEqual(r3.data[f], snaps[ids[2]][f], "field parity: " + f);
  }
});

test("паритет: API-снапшот побайтно равен DOM-снапшоту", async () => {
  const ids = ["200000000001", "200000000002", "200000000003"];
  const snaps = {};
  ids.forEach((id, i) => (snaps[id] = makeSnap(id, i + 10)));
  let call = 0;
  const { state, deps } = makeDriver({ snaps });
  deps.captureAndClear = async () => {
    const id = ids[Math.min(call++, ids.length - 1)];
    return [
      {
        url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
        method: "POST",
        status: 200,
        headers: { authorization: "Bearer T1" },
        body: JSON.stringify({ id }),
        responseText: JSON.stringify(RESP(id, snaps[id])),
      },
    ];
  };
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const apiRes = await reader.read({ articleId: ids[2] });
  const domRes = domDataFromSnap(snaps[ids[2]]);
  for (const f of M.SCRAPE_FIELDS) {
    assert.deepStrictEqual(apiRes.data[f], domRes[f], "field parity: " + f);
  }
});

test("паритет фильтра складов: чужой склад → matched='' и seen=true (в on)", async () => {
  // Наш склад — только СКЛАД_1. Объекты: свой, чужой, снова свой.
  const ids = ["700000000001", "700000000002", "700000000003"];
  const snaps = {
    "700000000001": Object.assign(makeSnap(ids[0], 1), { operationalWarehouse: "СКЛАД_1" }),
    "700000000002": Object.assign(makeSnap(ids[1], 1), { operationalWarehouse: "ЧУЖОЙ_СКЛАД" }),
    "700000000003": Object.assign(makeSnap(ids[2], 1), { operationalWarehouse: "СКЛАД_1" }),
  };
  let call = 0;
  const { deps } = makeDriver({ snaps });
  deps.captureAndClear = async () => {
    const id = ids[Math.min(call++, ids.length - 1)];
    return [
      {
        url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
        method: "POST",
        status: 200,
        headers: { authorization: "Bearer T1" },
        body: JSON.stringify({ id }),
        responseText: JSON.stringify(RESP(id, snaps[id])),
      },
    ];
  };
  // Обучаемся на двух своих складах (probe объекты — свой склад), затем on.
  const probeIds = [ids[0], ids[2]];
  const reader = R.createHubApiReader(deps, {
    verifyEveryN: 0,
    requireOpsField: true,
    opsWarehouses: ["СКЛАД_1"],
  });
  await reader.read({ articleId: probeIds[0] });
  await reader.read({ articleId: probeIds[1] });
  assert.strictEqual(reader.getPhase(), "on");
  // Теперь читаем «чужой» объект через API — склад не наш.
  const r = await reader.read({ articleId: ids[1] });
  assert.strictEqual(r.path, "api");
  assert.strictEqual(r.data.operationalWarehouse, "", "чужой склад → пусто (как в DOM)");
  assert.strictEqual(r.data.operationalWarehouseSeen, true, "склад присутствовал → seen=true");
});

test("401 в on → переучивание, затем снова API", async () => {
  const ids = ["300000000001", "300000000002", "300000000003"];
  const snaps = {};
  ids.forEach((id, i) => (snaps[id] = makeSnap(id, i + 20)));
  let call = 0;
  let firstApiFor3 = true;
  const { state, deps } = makeDriver({
    snaps,
    apiStatus: (id) => {
      if (id === ids[2] && firstApiFor3) {
        firstApiFor3 = false;
        return 401;
      }
      return 200;
    },
  });
  deps.captureAndClear = async () => {
    const id = ids[Math.min(call++, ids.length - 1)];
    return [
      {
        url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
        method: "POST",
        status: 200,
        headers: { authorization: "Bearer T1" },
        body: JSON.stringify({ id }),
        responseText: JSON.stringify(RESP(id, snaps[id])),
      },
    ];
  };
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const r3 = await reader.read({ articleId: ids[2] });
  assert.strictEqual(state.relearnCalls >= 1, true, "было переучивание");
  assert.strictEqual(r3.path, "api", "после переучивания снова API");
  assert.strictEqual(reader.getPhase(), "on");
});

test("две неуспешные пробы → off, дальше всегда DOM", async () => {
  const { state, deps } = makeDriver({
    snaps: { a: makeSnap("a", 1) },
  });
  // Захват не содержит подходящей ручки → обучение не происходит.
  deps.captureAndClear = async () => [];
  const reader = R.createHubApiReader(deps, { verifyEveryN: 0 });
  await reader.read({ articleId: "500000000001" });
  await reader.read({ articleId: "500000000002" });
  assert.strictEqual(reader.getPhase(), "off");
  const r = await reader.read({ articleId: "500000000003" });
  assert.strictEqual(r.path, "dom");
});

test("сверка находит расхождение → берём DOM и уходим в off", async () => {
  const ids = ["600000000001", "600000000002", "600000000003"];
  const snaps = {};
  ids.forEach((id, i) => (snaps[id] = makeSnap(id, i + 30)));
  let call = 0;
  const { state, deps } = makeDriver({ snaps });
  deps.captureAndClear = async () => {
    const id = ids[Math.min(call++, ids.length - 1)];
    return [
      {
        url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
        method: "POST",
        status: 200,
        headers: { authorization: "Bearer T1" },
        body: JSON.stringify({ id }),
        responseText: JSON.stringify(RESP(id, snaps[id])),
      },
    ];
  };
  // На сверке DOM вернёт другую цену, чем API → расхождение.
  const origDom = deps.domScrape;
  deps.domScrape = async (item) => {
    const d = await origDom(item);
    if (item.articleId === ids[2]) return Object.assign({}, d, { price: d.price + 999 });
    return d;
  };
  const reader = R.createHubApiReader(deps, { verifyEveryN: 1, maxMiscompares: 1 });
  await reader.read({ articleId: ids[0] });
  await reader.read({ articleId: ids[1] });
  const r3 = await reader.read({ articleId: ids[2] });
  assert.strictEqual(r3.path, "dom", "при расхождении отдаём DOM");
  assert.strictEqual(reader.getPhase(), "off");
});

module.exports = { tests };
