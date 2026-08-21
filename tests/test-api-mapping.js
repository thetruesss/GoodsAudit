// Тесты общих кирпичиков: заголовки авторизации, сравнение снапшотов,
// паритет фильтра складов, пейсер и машина состояний.
const assert = require("assert");
const M = require("../api-mapping.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("latestAuthHeaders берёт свежие и не считает cookie авторизацией", () => {
  const entries = [
    { headers: { authorization: "Bearer OLD", "x-o3-app-name": "alps-client" } },
    { headers: { authorization: "Bearer NEW", "x-o3-app-version": "release/LSR-19003", cookie: "s=1" } },
  ];
  const auth = M.latestAuthHeaders(entries);
  assert.strictEqual(auth.authorization, "Bearer NEW");
  assert.strictEqual(auth["x-o3-app-version"], "release/LSR-19003");
  assert.ok(!("cookie" in auth), "cookie не попадает в список заголовков");
});

test("latestAuthHeaders на пустом трафике возвращает пусто", () => {
  assert.deepStrictEqual(M.latestAuthHeaders([]), {});
  assert.deepStrictEqual(M.latestAuthHeaders([{ headers: { accept: "application/json" } }]), {});
});

test("сравнение значений: NBSP, запятая и число эквивалентны", () => {
  assert.strictEqual(M.parseLooseNumber("12 500,50"), 12500.5);
  assert.ok(M.valuesEqualLoose("12 500,50", 12500.5));
  assert.ok(M.valuesEqualLoose("МО_ИСТРА_ДО", " МО_ИСТРА_ДО "));
  assert.ok(!M.valuesEqualLoose("FBS", "FBO"));
});

test("snapshotsMatch сверяет только непустые поля эталона", () => {
  const dom = { price: 100, nomenclature: "Товар", shipment: "", statusLozon: "Недостача" };
  const api = { price: 100, nomenclature: "Товар", shipment: "0179-1", statusLozon: "Недостача" };
  const fields = M.nonEmptySnapshotFields(dom);
  assert.ok(!fields.includes("shipment"), "пустое поле DOM не сверяется");
  assert.strictEqual(M.snapshotsMatch(api, dom, fields).ok, true);
  const bad = M.snapshotsMatch({ ...api, price: 101 }, dom, fields);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.mismatches, ["price"]);
});

test("resolveOpsWarehouse: паритет с DOM-фильтром складов", () => {
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ", []), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ", ["МО_ИСТРА_ХАБ"]), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
  assert.deepStrictEqual(M.resolveOpsWarehouse("ЧУЖОЙ", ["МО_ИСТРА_ХАБ"]), {
    matched: "",
    seen: true,
  });
  assert.deepStrictEqual(M.resolveOpsWarehouse("", ["МО_ИСТРА_ХАБ"]), {
    matched: "",
    seen: false,
  });
  assert.deepStrictEqual(M.resolveOpsWarehouse("МО_ИСТРА_ХАБ — Зона", ["МО_ИСТРА_ХАБ"]), {
    matched: "МО_ИСТРА_ХАБ",
    seen: true,
  });
});

test("пейсер: 3 запроса при 100 rps занимают ~20 мс", async () => {
  const pacer = M.createRequestPacer(100);
  const t0 = Date.now();
  await pacer.take(1);
  await pacer.take(1);
  await pacer.take(1);
  const dt = Date.now() - t0;
  assert.ok(dt >= 15 && dt < 200, "уложились в ожидаемое окно, получили " + dt);
});

test("машина состояний: включается после N удачных сверок", () => {
  const c = M.createApiModeController({ okProbesToEnable: 2 });
  assert.strictEqual(c.getPhase(), "probe");
  c.probeSuccess();
  assert.strictEqual(c.getPhase(), "probe", "одной сверки мало");
  c.probeSuccess();
  assert.strictEqual(c.getPhase(), "on");
});

test("машина состояний: две неудачные пробы → off", () => {
  const c = M.createApiModeController({ maxProbeFails: 2 });
  c.probeFail("x");
  assert.strictEqual(c.getPhase(), "probe");
  c.probeFail("y");
  assert.strictEqual(c.getPhase(), "off");
  assert.strictEqual(c.getReason(), "y");
});

test("машина состояний: 401 → переучивание, повторный 401 после него → off", () => {
  const c = M.createApiModeController({ okProbesToEnable: 1, maxRelearnFails: 2 });
  c.probeSuccess();
  assert.strictEqual(c.getPhase(), "on");
  c.batch401();
  assert.strictEqual(c.getPhase(), "on", "ждём переучивание");
  c.relearnDone();
  c.batch401();
  c.relearnDone();
  c.batch401();
  assert.strictEqual(c.getPhase(), "off");
});

test("машина состояний: расхождения на сверке → off", () => {
  const c = M.createApiModeController({ okProbesToEnable: 1, maxMiscompares: 2 });
  c.probeSuccess();
  c.miscompare();
  assert.strictEqual(c.getPhase(), "on");
  c.miscompare();
  assert.strictEqual(c.getPhase(), "off");
  assert.strictEqual(c.getReason(), "verify-mismatch");
});

test("пул вкладок: выдаёт свободные, лишние ждут очереди", async () => {
  const pool = M.createTabPool([11, 22]);
  const a = await pool.acquire();
  const b = await pool.acquire();
  assert.deepStrictEqual([a, b], [11, 22]);
  assert.strictEqual(pool.free(), 0);

  let third = null;
  const waiting = pool.acquire().then((id) => (third = id));
  await Promise.resolve();
  assert.strictEqual(third, null, "третий ждёт, а не берёт несуществующую вкладку");
  assert.strictEqual(pool.waiting(), 1);

  pool.release(a);
  await waiting;
  assert.strictEqual(third, 11, "освободившаяся вкладка уходит ожидающему");
  assert.strictEqual(pool.free(), 0, "мимо очереди в свободные она не попадает");
});

test("пул вкладок: повторный release не размножает вкладку", async () => {
  const pool = M.createTabPool([7]);
  const id = await pool.acquire();
  pool.release(id);
  pool.release(id);
  assert.strictEqual(pool.free(), 1);
  assert.strictEqual(await pool.acquire(), 7);
  assert.strictEqual(pool.free(), 0);
});

test("пул вкладок: зависшая вкладка меняется на свежую", async () => {
  const pool = M.createTabPool([1, 2]);
  const bad = await pool.acquire();
  pool.replace(bad, 99);
  pool.release(99);
  assert.deepStrictEqual(pool.all().sort((x, y) => x - y), [2, 99]);
  assert.strictEqual(pool.size(), 2, "вкладок не стало больше");
  pool.release(bad);
  assert.strictEqual(pool.free(), 2, "мёртвая вкладка обратно в пул не возвращается");
});

test("пул вкладок: добавленная вкладка достаётся ожидающему", async () => {
  const pool = M.createTabPool([5]);
  await pool.acquire();
  let got = null;
  const waiting = pool.acquire().then((id) => (got = id));
  await Promise.resolve();
  assert.strictEqual(got, null);
  pool.add(6);
  await waiting;
  assert.strictEqual(got, 6);
  assert.strictEqual(pool.size(), 2);
});

test("пейсер: 429 роняет скорость вдвое и ставит паузу", async () => {
  const pacer = M.createRequestPacer(80, { minRps: 10, maxRps: 160 });
  assert.strictEqual(pacer.getRate(), 80);
  pacer.report({ status: 429, retryAfterMs: 0 });
  assert.strictEqual(pacer.getRate(), 40, "вдвое вниз");
  pacer.report({ status: 503 });
  assert.strictEqual(pacer.getRate(), 20);
  pacer.report({ status: 500 });
  assert.strictEqual(pacer.getRate(), 10);
  pacer.report({ status: 502 });
  assert.strictEqual(pacer.getRate(), 10, "ниже пола не опускаемся");
  assert.strictEqual(pacer.stats().throttles, 4);
});

test("пейсер: наш собственный обрыв не роняет скорость, но и не разгоняет", async () => {
  const pacer = M.createRequestPacer(40, { maxRps: 200, stepUpRps: 10, okBeforeStepUp: 2 });
  pacer.report({ status: 200, ms: 30 });
  // Запрос вообще не ушёл — сервис об этом ничего не сказал.
  pacer.report({ status: 0 });
  assert.strictEqual(pacer.getRate(), 40, "скорость не тронута");
  assert.strictEqual(pacer.stats().throttles, 0, "это не отказ сервиса");
  pacer.report({ status: 200, ms: 30 });
  assert.strictEqual(pacer.getRate(), 40, "разгон начинается заново, а не продолжается");
  pacer.report({ status: 200, ms: 30 });
  assert.strictEqual(pacer.getRate(), 50);
});

test("пейсер: на чистых ответах планка растёт до потолка и не выше", async () => {
  const pacer = M.createRequestPacer(40, { maxRps: 60, stepUpRps: 5, okBeforeStepUp: 3 });
  for (let i = 0; i < 3; i++) pacer.report({ status: 200, ms: 30 });
  assert.strictEqual(pacer.getRate(), 45);
  for (let i = 0; i < 30; i++) pacer.report({ status: 200, ms: 30 });
  assert.strictEqual(pacer.getRate(), 60, "выше потолка не уходим");
});

test("пейсер: выросшие задержки останавливают разгон до отказов", async () => {
  const pacer = M.createRequestPacer(40, { maxRps: 200, stepUpRps: 5, okBeforeStepUp: 2 });
  pacer.report({ status: 200, ms: 30 });
  pacer.report({ status: 200, ms: 30 });
  assert.strictEqual(pacer.getRate(), 45, "пока быстро — разгоняемся");
  for (let i = 0; i < 60; i++) pacer.report({ status: 200, ms: 900 });
  assert.strictEqual(pacer.getRate(), 45, "задержки выросли — стоим, а не давим дальше");
});

test("пейсер: после 429 запросы действительно ждут паузу", async () => {
  const pacer = M.createRequestPacer(1000, { minRps: 500 });
  pacer.report({ status: 429, retryAfterMs: 120 });
  const t0 = Date.now();
  await pacer.take(1);
  const waited = Date.now() - t0;
  assert.ok(waited >= 100, `ждали ${waited} мс, а должны были около 120`);
});

module.exports = { tests };
