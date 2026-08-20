// Тесты рабочего цикла: чтение через API вкладку не занимает, поэтому вкладок
// должно быть 1 сессионная + 2 под страницы, а не «вкладка на поток». И если
// API не поднялся, пул обязан вырасти обратно, иначе прогон встанет.
const assert = require("assert");
const { run } = require("./run-loop.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let liveRun = null;
let deadRun = null;
const withLive = async () => (liveRun = liveRun || (await run({ apiWorks: true, count: 40 })));
const withDead = async () => (deadRun = deadRun || (await run({ apiWorks: false, count: 40 })));

test("быстрое чтение работает: вкладок 3, а не по одной на поток", async () => {
  const r = await withLive();
  assert.ok(
    r.state.maxTabs <= 3,
    `открыто вкладок: ${r.state.maxTabs}, ждали не больше 3 (сессионная + две под страницы)`
  );
});

test("быстрое чтение работает: страница открывается единицы раз на весь прогон", async () => {
  const r = await withLive();
  assert.ok(
    r.state.navigations <= 5,
    `переходов на страницу: ${r.state.navigations} на 40 объектов — должно хватать проб и переучивания`
  );
  assert.ok(r.job.readStats.api > r.job.readStats.dom, JSON.stringify(r.job.readStats));
});

test("быстрое чтение работает: все объекты обработаны без ошибок", async () => {
  const r = await withLive();
  assert.strictEqual(r.job.errors.length, 0, JSON.stringify(r.job.errors.slice(0, 2)));
  assert.strictEqual(r.job.results.length, 40);
  assert.strictEqual(r.job.phase, "done");
});

test("API мёртв: пул вкладок вырастает обратно под потоки", async () => {
  const r = await withDead();
  assert.ok(r.state.maxTabs >= 6, `вкладок стало ${r.state.maxTabs}, а потоков 6`);
  assert.strictEqual(r.job.readStats.api, 0);
});

test("API мёртв: прогон всё равно доходит до конца", async () => {
  const r = await withDead();
  assert.strictEqual(r.job.errors.length, 0, JSON.stringify(r.job.errors.slice(0, 2)));
  assert.strictEqual(r.job.results.length, 40);
  assert.strictEqual(r.job.phase, "done");
});

module.exports = { tests };
