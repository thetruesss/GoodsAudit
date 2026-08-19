// Тесты чистой логики маппинга/машины состояний/пейсера. Запуск: node tests/run.js
const assert = require("assert");
const M = require("../api-mapping.js");
const R = require("../api-reader.js");

// Фикстура «живого» ответа: две записи-объекта, вложенные структуры, null-блоки,
// цена в копейках/строке, NBSP, рейс вместо склада.
const RESP_1 = {
  totalCount: 1,
  records: [
    {
      articleId: "451234567890",
      shipment: "0179-2233445-0001",
      price: "12 500,50",
      item: { name: "Смартфон Xiaomi Redmi Note 13" },
      place: { warehouse: { name: "МО_ИСТРА_ХАБ" } },
      delivery: { scheme: "FBO" },
      formation: { warehouse: "СЦ Хоругвино" },
      owner: { title: "ООО Ромашка" },
      statuses: { lozon: "На складе", alps: "Готов", active: "Активен" },
      meta: { nested: { deep: null } },
    },
  ],
};

const RESP_2 = {
  totalCount: 1,
  records: [
    {
      articleId: "998877665544",
      shipment: "0179-9988776-0002",
      price: 7000,
      item: { name: "Наушники Sony" },
      place: { warehouse: { name: "МО_КОТ_ХАБ" } },
      delivery: { scheme: "FBS" },
      formation: { warehouse: "СЦ Софьино" },
      owner: { title: "ИП Иванов" },
      statuses: { lozon: "В пути", alps: "Ждёт", active: "Активен" },
      meta: { nested: { deep: null } },
    },
  ],
};

// Снапшоты, как их отдал бы DOM-скрейпер (paritет обязателен).
const SNAP_1 = {
  price: 12500.5,
  nomenclature: "Смартфон Xiaomi Redmi Note 13",
  shipment: "0179-2233445-0001",
  articleId: "451234567890",
  operationalWarehouse: "МО_ИСТРА_ХАБ",
  deliveryScheme: "FBO",
  formationWarehouse: "СЦ Хоругвино",
  owner: "ООО Ромашка",
  status: "Активен",
  statusLozon: "На складе",
  statusAlps: "Готов",
};
const SNAP_2 = {
  price: 7000,
  nomenclature: "Наушники Sony",
  shipment: "0179-9988776-0002",
  articleId: "998877665544",
  operationalWarehouse: "МО_КОТ_ХАБ",
  deliveryScheme: "FBS",
  formationWarehouse: "СЦ Софьино",
  owner: "ИП Иванов",
  status: "Активен",
  statusLozon: "В пути",
  statusAlps: "Ждёт",
};

function entry(id, resp) {
  return {
    url: `https://returns.o3t.ru/p-api/articles/${id}/data`,
    method: "POST",
    status: 200,
    headers: { authorization: "Bearer TESTTOKEN", "x-o3-app-name": "scms", cookie: "s=1" },
    body: JSON.stringify({ id: id, pagination: { pageNumber: 1, pageSize: 20 } }),
    responseText: JSON.stringify(resp),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("template roundtrip: URL + body параметризуются по ID", () => {
  const t = M.buildRequestTemplate(entry("451234567890", RESP_1), "451234567890");
  assert.ok(t, "template built");
  const applied = M.applyRequestTemplate(t, "998877665544");
  assert.strictEqual(applied.url, "https://returns.o3t.ru/p-api/articles/998877665544/data");
  assert.ok(applied.body.includes("998877665544"));
  assert.ok(!applied.body.includes("451234567890"));
});

test("границы слова: ID внутри другого числа не заменяется", () => {
  const e = {
    url: "https://x/a/123",
    method: "GET",
    status: 200,
    headers: {},
    body: null,
    responseText: "{}",
  };
  // '123' встречается в '1234' — не должно параметризоваться как отдельный ID.
  const t = M.buildRequestTemplate({ ...e, url: "https://x/a/1234" }, "123");
  assert.strictEqual(t, null, "no standalone occurrence → no template");
});

test("learn + refine: маппинг обучается на 1-м и проверяется на 2-м объекте", () => {
  const learned = M.learnFromEntries([entry("451234567890", RESP_1)], "451234567890", SNAP_1);
  assert.ok(learned, "learned from first object");
  assert.ok(learned.template, "has template");
  const json2 = RESP_2;
  const refined = M.refineMapping(learned.fieldCandidates, json2, SNAP_2);
  assert.ok(refined.ok, "refine ok: " + JSON.stringify(refined.mismatches || []));
  const extracted = M.extractSnapshotByMapping(json2, refined.mapping);
  assert.ok(extracted.ok, "extract ok");
  assert.deepStrictEqual(
    M.snapshotsMatch(extracted.snapshot, SNAP_2, M.nonEmptySnapshotFields(SNAP_2)).ok,
    true,
    "extracted snapshot matches DOM snapshot"
  );
});

test("extract: пустая номенклатура ловится проверкой вменяемости → DOM fallback", () => {
  const learned = M.learnFromEntries([entry("451234567890", RESP_1)], "451234567890", SNAP_1);
  const refined = M.refineMapping(learned.fieldCandidates, RESP_2, SNAP_2);
  // Ломаем ответ: номенклатура стала null.
  const broken = JSON.parse(JSON.stringify(RESP_2));
  broken.records[0].item.name = null;
  const extracted = M.extractSnapshotByMapping(broken, refined.mapping);
  // Строковое поле с null допускается маппером как пустая строка…
  assert.strictEqual(extracted.snapshot.nomenclature, "");
  // …но объект без номенклатуры не проходит проверку вменяемости — уйдёт в DOM.
  assert.strictEqual(
    M.extractedSnapshotLooksSane(extracted.snapshot),
    false,
    "empty nomenclature → not sane → DOM fallback"
  );
});

test("extract: цена-объект (нечисло) в обученном поле → extract fails", () => {
  const learned = M.learnFromEntries([entry("451234567890", RESP_1)], "451234567890", SNAP_1);
  const refined = M.refineMapping(learned.fieldCandidates, RESP_2, SNAP_2);
  const broken = JSON.parse(JSON.stringify(RESP_2));
  broken.records[0].price = { amount: "nope" };
  const extracted = M.extractSnapshotByMapping(broken, refined.mapping);
  assert.strictEqual(extracted.ok, false, "non-numeric price in learned number field → fail");
});

test("price/NBSP/запятая парсятся одинаково", () => {
  assert.strictEqual(M.parseLooseNumber("12 500,50"), 12500.5);
  assert.strictEqual(M.parseLooseNumber("7000"), 7000);
  assert.ok(M.valuesEqualLoose("12 500,50", 12500.5));
});

test("latestAuthHeaders берёт последние и фильтрует куки", () => {
  const auth = M.latestAuthHeaders([entry("1", RESP_1)]);
  assert.strictEqual(auth.authorization, "Bearer TESTTOKEN");
  assert.strictEqual(auth["x-o3-app-name"], "scms");
  assert.ok(!("cookie" in auth), "cookie not treated as auth header");
});

test("пейсер: 3 запроса при 100 rps занимают ~20 мс", async () => {
  const pacer = M.createRequestPacer(100);
  const t0 = Date.now();
  await pacer.take(1);
  await pacer.take(1);
  await pacer.take(1);
  const dt = Date.now() - t0;
  assert.ok(dt >= 15 && dt < 200, "paced within expected window, got " + dt);
});

test("resolveOpsWarehouse: паритет с DOM-фильтром складов", () => {
  // Без фильтра — берём сырое значение.
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ", []), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
  // Точное совпадение с фильтром.
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ", ["МО_ИСТРА_ХАБ"]), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
  // Есть склад, но не наш → matched пуст, seen=true (в DOM → «не наш склад»).
  assert.deepStrictEqual(M.resolveOpsWarehouse("ЧУЖОЙ", ["МО_ИСТРА_ХАБ"]), {
    matched: "",
    seen: true,
  });
  // Склада нет → seen=false (в DOM → «не найден склад»).
  assert.deepStrictEqual(M.resolveOpsWarehouse("", ["МО_ИСТРА_ХАБ"]), {
    matched: "",
    seen: false,
  });
  // Совпадение по сегменту через « — ».
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ — Зона", ["МО_ИСТРА_ХАБ"]), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
});

test("state machine: probe → on при успехе", () => {
  const c = M.createApiModeController();
  assert.strictEqual(c.getPhase(), "probe");
  c.probeSuccess();
  assert.strictEqual(c.getPhase(), "on");
});

test("state machine: две неудачные пробы → off", () => {
  const c = M.createApiModeController({ maxProbeFails: 2 });
  c.probeFail("x");
  assert.strictEqual(c.getPhase(), "probe");
  c.probeFail("y");
  assert.strictEqual(c.getPhase(), "off");
});

test("state machine: 401 в on → переучивание, повторный 401 после → off", () => {
  const c = M.createApiModeController({ maxRelearnFails: 2 });
  c.probeSuccess();
  c.batch401();
  assert.strictEqual(c.getPhase(), "on", "остаёмся on, ждём переучивание");
  c.relearnDone();
  c.batch401(); // 401 сразу после переучивания
  c.relearnDone();
  c.batch401();
  assert.strictEqual(c.getPhase(), "off");
});

test("state machine: расхождения на сверке → off", () => {
  const c = M.createApiModeController({ maxMiscompares: 2 });
  c.probeSuccess();
  c.miscompare();
  assert.strictEqual(c.getPhase(), "on");
  c.miscompare();
  assert.strictEqual(c.getPhase(), "off");
});

module.exports = { tests };
