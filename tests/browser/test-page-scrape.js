// Тесты чтения страницы (page-scrape.js) в настоящем браузере.
//
// Нужен playwright и Chromium: `node tests/browser/test-page-scrape.js`.
// Без них тест пропускается — основной раннер (tests/run.js) остаётся без
// зависимостей. Вынесено в браузер потому, что page-scrape ходит по живому DOM
// (closest, innerText, querySelectorAll), и подделывать это фейком дороже и
// менее честно, чем прогнать в Chromium.
const fs = require("fs");
const path = require("path");

const SCRAPE = fs.readFileSync(path.join(__dirname, "..", "..", "page-scrape.js"), "utf8");

// Вёрстка карточки различается по строкам: где-то значение обёрнуто в узел,
// где-то лежит прямо в контейнере, где-то это ссылка. Живой прогон показал, что
// «Собственник» на карточке отправления рисуется без обёртки — и терялся.
const rowWrapped = (label, value) =>
  `<div class="_propertiesGridRow_a"><div class="_label_a"><span>${label}</span></div>` +
  `<div class="_content_a"><div class="paragraph-medium paddingBottomOff">${value}</div></div></div>`;
const rowBare = (label, value) =>
  `<div class="_propertiesGridRow_b"><div class="_label_b"><span>${label}</span></div>` +
  `<div class="_content_b">${value}</div></div>`;
const rowLink = (label, value) =>
  `<div class="_propertiesGridRow_c"><div class="_label_c"><span>${label}</span></div>` +
  `<div class="_content_c"><a href="#">${value}</a></div></div>`;

const POSTING_HTML =
  "<html><body>Отправление Упаковка отправления Номенклатура" +
  rowWrapped("Номер отправления", "64883101-0260-1") +
  rowBare("Собственник", "Бамматова Барият Хангишиевна, ИП") +
  rowLink("Договор", "ИР-1210743/25 от 10.07.2025 25186091876000") +
  rowWrapped("Схема доставки", "FBS") +
  rowBare("Склад формирования", "FBS/3152433/Skladmo 1020005000244066") +
  rowWrapped("Статус lozon", "Доставлен") +
  rowBare("Текущее место", "СИМФЕРОПОЛЬ_288 1020005001690180") +
  "<table><thead><tr><th>Номенклатура</th></tr></thead>" +
  "<tbody><tr><td>Сумка тактическая Helikon-Tex</td></tr></tbody></table>" +
  "</body></html>";

// Объект в пути: текущее место чужое, наш склад — в «Последней перевозке».
const IN_TRANSIT_HTML =
  "<html><body>Отправление Упаковка отправления Номенклатура" +
  rowBare("Текущее место", "КРАСНОДАР_2_РФЦ 1020003111522000") +
  "<div>Последняя перевозка<table><tbody><tr>" +
  '<td class="_tableCellRoute_a">МО_КРАСНОГОРСК_141</td>' +
  '<td class="_tableCellRoute_a">МО_ИСТРА_ДО</td>' +
  "</tr></tbody></table></div>" +
  "</body></html>";

const cases = [];
const check = (name, got, want) => cases.push({ name, got, want });

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.log("playwright не установлен — тест пропущен");
    return 0;
  }
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}
  );
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.setContent(POSTING_HTML);
  await page.evaluate(SCRAPE);
  const snap = await page.evaluate(() => globalThis.__returnsReadPage(["МО_ИСТРА_ХАБ"]));

  check("собственник читается, когда значение прямо в контейнере", snap.owner, "Бамматова Барият Хангишиевна, ИП");
  check("схема доставки читается из вложенного узла", snap.deliveryScheme, "FBS");
  check("у склада формирования отрезан хвостовой id", snap.formationWarehouse, "FBS/3152433/Skladmo");
  check("статус lozon", snap.statusLozon, "Доставлен");
  check("номенклатура — первая строка таблицы", snap.nomenclature, "Сумка тактическая Helikon-Tex");
  check("чужой опер. склад пустеет", snap.operationalWarehouse, "");
  check("но склад на карточке считается увиденным", snap.operationalWarehouseSeen, true);

  await page.setContent(IN_TRANSIT_HTML);
  await page.evaluate(SCRAPE);
  const transit = await page.evaluate(() => globalThis.__returnsReadPage(["МО_ИСТРА_ДО"]));
  check("объект в пути: наш склад найден в последней перевозке", transit.operationalWarehouse, "МО_ИСТРА_ДО");

  await browser.close();

  let failed = 0;
  for (const c of cases) {
    const ok = JSON.stringify(c.got) === JSON.stringify(c.want);
    if (!ok) failed += 1;
    console.log(
      (ok ? "  ok   " : "  FAIL ") +
        c.name +
        (ok ? "" : `\n       получили ${JSON.stringify(c.got)}, ждали ${JSON.stringify(c.want)}`)
    );
  }
  for (const e of errors) {
    failed += 1;
    console.error("  FAIL ошибка на странице: " + e);
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error("FATAL", e);
  process.exit(1);
});
