// Тесты маппинга ответов API returns.o3t.ru в снапшот, эквивалентный DOM.
// Фикстуры postings взяты из живого HAR карточки returns.o3t.ru.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const RT = require("../api-returns.js");

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

const POSTING_INFO = fixture("posting-info.json");
const POSTING_CONTENT = fixture("posting-content.json");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("posting: живой ответ раскладывается в поля как на странице", () => {
  const snap = RT.mapPosting(POSTING_INFO, POSTING_CONTENT);
  assert.strictEqual(snap.articleId, "501883634205000");
  assert.strictEqual(snap.shipment, "0136207144-0017-1");
  assert.strictEqual(snap.price, 9877);
  assert.strictEqual(
    snap.nomenclature,
    "Чехлы Автопилот Экокожа HONDA CR-V II с 02-07г. (Хонда ЦРВ 2) Серый + Серый"
  );
  assert.strictEqual(snap.operationalWarehouse, "МО_ИСТРА_ДО");
  assert.strictEqual(snap.formationWarehouse, "FBS/2156699/Чагинская (мир чехлов)");
  assert.strictEqual(snap.owner, "Спренченат Сергей Анатольевич, ИП");
  // Коды переводятся в подписи, которые реально отображаются в вёрстке.
  assert.strictEqual(snap.deliveryScheme, "FBS", "fbs → FBS");
  assert.strictEqual(snap.statusLozon, "Недостача", "lost → Недостача");
  assert.strictEqual(snap.status, "Недостача", "первый бейдж шапки = статус lozon");
  assert.strictEqual(snap.statusAlps, "", "alpsStatus null → пусто");
  assert.strictEqual(snap.isTransitBox, false);
  assert.strictEqual(snap.isC2C, false);
  assert.strictEqual(snap.unsupportedTransitBox, false);
});

test("statusAlps: код переводится в подпись, как на странице", () => {
  const info = Object.assign({}, POSTING_INFO, { alpsStatus: "completed" });
  const snap = RT.mapPosting(info, POSTING_CONTENT);
  assert.strictEqual(snap.statusAlps, "Завершен", "completed → Завершен");
  assert.strictEqual(RT.alpsLabel("waitingForSeller"), "Готов к выдаче");
  assert.strictEqual(RT.alpsLabel("deficitRevealed"), "Недостача");
  assert.strictEqual(RT.alpsLabel(""), "", "пустой код → пусто");
  // Незнакомый код ALPS отправляет объект на страницу, а не подставляет пустоту.
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("posting", {
      lozonState: "lost",
      deliverySchema: "fbs",
      alpsStatus: "brandNewAlpsState",
    }),
    true
  );
});

test("boxTransit: ALPS-статус тоже подписью, unknown скрыт", () => {
  const base = {
    info: {
      id: 5,
      mainInfo: { containerName: "1019751004201754", deliverySchema: "fbo" },
      placeInfo: {},
      statuses: { lozonState: "banded", returnStatus: "utilization" },
    },
  };
  assert.strictEqual(RT.mapTransitBox(base, null).statusAlps, "Утилизируется");
  base.info.statuses.returnStatus = "unknown";
  assert.strictEqual(RT.mapTransitBox(base, null).statusAlps, "", "unknown → поле скрыто");
});

test("posting C2C: страница прячет сумму и собственника — прячем и мы", () => {
  const info = Object.assign({}, POSTING_INFO, { deliverySchema: "delivery" });
  const snap = RT.mapPosting(info, POSTING_CONTENT);
  assert.strictEqual(snap.deliveryScheme, "C2C", "delivery → C2C");
  assert.strictEqual(snap.price, null, "у C2C суммы на странице нет");
  assert.strictEqual(snap.owner, "", "у C2C собственника на странице нет");
  assert.strictEqual(snap.isC2C, true);
});

test("posting: номенклатура берётся как первая строка таблицы состава", () => {
  const content = {
    exemplars: [
      { modelName: "" },
      { modelName: "1234567890123" },
      { modelName: "Наушники Sony WH-1000XM5" },
    ],
  };
  const snap = RT.mapPosting(POSTING_INFO, content);
  assert.strictEqual(snap.nomenclature, "Наушники Sony WH-1000XM5");
});

test("posting: пустой состав → номенклатура пустая (нормализация решит дальше)", () => {
  const snap = RT.mapPosting(POSTING_INFO, { exemplars: [] });
  assert.strictEqual(snap.nomenclature, "");
});

test("exemplar: маппинг основных полей карточки экземпляра", () => {
  const info = {
    exemplarId: 701883311344000,
    modelName: "Смартфон Xiaomi Redmi Note 13",
    price: { value: 15990.5, currency: "RUB" },
    deliverySchema: "fbo",
    formationWarehouseName: "СЦ Хоругвино",
    currentWarehouseName: "МО_ИСТРА_ХАБ",
    contractCustomerName: "ООО Ромашка",
    lozonExemplarState: "taken",
    alpsStatus: "completed",
  };
  const snap = RT.mapExemplar(info);
  assert.strictEqual(snap.articleId, "701883311344000");
  assert.strictEqual(snap.nomenclature, "Смартфон Xiaomi Redmi Note 13");
  assert.strictEqual(snap.price, 15990.5);
  assert.strictEqual(snap.deliveryScheme, "FBO");
  assert.strictEqual(snap.operationalWarehouse, "МО_ИСТРА_ХАБ");
  assert.strictEqual(snap.formationWarehouse, "СЦ Хоругвино");
  assert.strictEqual(snap.owner, "ООО Ромашка");
  assert.strictEqual(snap.statusLozon, "Прибыл в место назначения", "taken → подпись");
  assert.strictEqual(snap.statusAlps, "Завершен", "completed → Завершен");
  assert.strictEqual(snap.shipment, "", "номера отправления в карточке экземпляра нет");
});

test("boxTransit: маппинг транзитной коробки", () => {
  const payload = {
    info: {
      id: 851348957478000,
      mainInfo: {
        returnInventoryId: "RI-99887766",
        containerName: "1019751004201754",
        deliverySchema: "fbo",
        price: { value: 42000, currency: "RUB" },
        sellerInfo: { id: 24680709081000, name: "ООО Селлер" },
        isReturn: true,
      },
      placeInfo: {
        sourcePlace: { id: 1, name: "СЦ Софьино" },
        currentPlace: { id: 2, name: "МО_ИСТРА_ХАБ" },
        destinationPlace: { id: 3, name: "ОМСК_714" },
      },
      statuses: { lozonState: "banded", returnStatus: "utilization" },
    },
  };
  const content = { exemplars: [{ modelName: "Телевизор LG 55" }] };
  const snap = RT.mapTransitBox(payload, content);
  assert.strictEqual(snap.articleId, "851348957478000");
  assert.strictEqual(snap.shipment, "RI-99887766", "приоритет returnInventoryId");
  assert.strictEqual(snap.price, 42000);
  assert.strictEqual(snap.nomenclature, "Телевизор LG 55");
  assert.strictEqual(snap.operationalWarehouse, "МО_ИСТРА_ХАБ");
  assert.strictEqual(snap.formationWarehouse, "СЦ Софьино");
  assert.strictEqual(snap.owner, "ООО Селлер");
  assert.strictEqual(snap.statusLozon, "Сформирован", "banded → Сформирован");
  assert.strictEqual(snap.statusAlps, "Утилизируется", "utilization → подпись");
  assert.strictEqual(snap.isTransitBox, true);
});

test("boxTransit: без returnInventoryId берём имя контейнера, без seller.id — пустой собственник", () => {
  const payload = {
    info: {
      id: 5,
      mainInfo: {
        returnInventoryId: null,
        containerName: "1019751004201754",
        deliverySchema: "fbo",
        sellerInfo: { id: null, name: "Не показывается" },
      },
      placeInfo: {},
      statuses: { lozonState: "disbanded", returnStatus: "unknown" },
    },
  };
  const snap = RT.mapTransitBox(payload, null);
  assert.strictEqual(snap.shipment, "1019751004201754");
  assert.strictEqual(snap.owner, "", "без id продавца страница не рисует собственника");
  assert.strictEqual(snap.statusAlps, "", "returnStatus unknown → пусто");
  assert.strictEqual(snap.operationalWarehouse, "");
});

test("неподдерживаемые типы: помечаются как в DOM, без загрузки страницы", () => {
  for (const type of ["box", "pallet", "sack", "boxTare", "containerTransit", "unknown"]) {
    assert.strictEqual(RT.isSupportedType(type), false, type + " не поддерживается профилем");
  }
  for (const type of ["posting", "exemplar", "boxTransit"]) {
    assert.strictEqual(RT.isSupportedType(type), true, type + " поддерживается");
  }
  const snap = RT.mapUnsupported("851348957478000");
  assert.strictEqual(snap.unsupportedTransitBox, true);
  assert.strictEqual(snap.articleId, "851348957478000");
  assert.strictEqual(snap.price, null);
});

test("неизвестный код статуса/схемы → объект дочитывается страницей", () => {
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("posting", { lozonState: "lost", deliverySchema: "fbs" }),
    false
  );
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("posting", { lozonState: "brandNewState", deliverySchema: "fbs" }),
    true,
    "новый статус на бэке → не доверяем API по этому объекту"
  );
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("posting", { lozonState: "lost", deliverySchema: "newSchema" }),
    true
  );
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("boxTransit", {
      info: { statuses: { lozonState: "zzz" }, mainInfo: { deliverySchema: "fbo" } },
    }),
    true
  );
});

test("id, потерявший точность в JSON, отправляет объект на страницу", () => {
  assert.strictEqual(RT.isUnsafeNumericId(501883634205000), false, "обычный id точен");
  assert.strictEqual(RT.isUnsafeNumericId(90071992547409931), true, "за пределами точности");
  assert.strictEqual(RT.isUnsafeNumericId("90071992547409931"), false, "строка точна");
  assert.strictEqual(
    RT.snapshotHasUnknownCodes("posting", {
      lozonState: "lost",
      deliverySchema: "fbs",
      lozonId: 90071992547409931,
    }),
    true
  );
});

test("подписи статусов совпадают со словарём приложения", () => {
  assert.strictEqual(RT.stateLabel("giveOutClient"), "Выдан клиенту");
  assert.strictEqual(RT.stateLabel("arrivedToPostomat"), "Доставлен в постамат");
  assert.strictEqual(RT.stateLabel("writtenOff"), "Списан");
  assert.strictEqual(RT.stateLabel(""), "");
  assert.strictEqual(RT.schemaLabel("crossBorder"), "CrossBorder");
  assert.strictEqual(RT.schemaLabel("delivery"), "C2C");
  assert.strictEqual(RT.schemaLabel("unknown"), "");
});

test("построение запросов: адреса ручек и параметры", () => {
  assert.strictEqual(
    RT.resolveTypeRequest("0136207144-0017-1").url,
    "/p-api/alps-api/v1/ArticleProfile/ArticleResolver/get-article-type?article=0136207144-0017-1"
  );
  assert.strictEqual(
    RT.infoRequest("posting", "501883634205000").url,
    "/p-api/alps-api/v1/ArticleProfile/Posting/info?id=501883634205000"
  );
  assert.strictEqual(
    RT.infoRequest("exemplar", "7").url,
    "/p-api/alps-api/v1/ArticleProfile/Exemplar/info?id=7"
  );
  assert.strictEqual(
    RT.infoRequest("boxTransit", "8").url,
    "/p-api/alps-api/v1/ArticleProfile/TransitBox/info?id=8"
  );
  assert.strictEqual(RT.infoRequest("pallet", "9"), null);
  assert.strictEqual(
    RT.contentRequest("posting", "501883634205000").url,
    "/p-api/alps-api/v1/ArticleProfile/Posting/posting-content/501883634205000"
  );
  assert.strictEqual(
    RT.contentRequest("boxTransit", "8").url,
    "/p-api/alps-api/v1/ArticleProfile/TransitBox/content/8"
  );
  assert.strictEqual(RT.contentRequest("exemplar", "7"), null, "у экземпляра состав не нужен");
});

test("битые ответы не роняют маппер", () => {
  assert.strictEqual(RT.mapPosting(null, null), null);
  assert.strictEqual(RT.mapExemplar(undefined), null);
  assert.strictEqual(RT.mapTransitBox(null, null), null);
  const partial = RT.mapPosting({ lozonId: 1 }, null);
  assert.strictEqual(partial.articleId, "1");
  assert.strictEqual(partial.price, null);
  assert.strictEqual(partial.nomenclature, "");
  assert.strictEqual(partial.statusLozon, "");
});

test("коробка, которую профиль не показывает: конверт isSupported=false", () => {
  const snap = RT.mapTransitBox({ info: null, isSupported: false }, { exemplars: [] });
  assert.strictEqual(snap.unsupportedTransitBox, true, "как информер на странице");
  assert.strictEqual(snap.nomenclature, "");
  assert.strictEqual(snap.operationalWarehouseSeen, false);
  assert.strictEqual(RT.payloadSaysUnsupported("boxTransit", { info: null, isSupported: false }), true);
  assert.strictEqual(
    RT.payloadSaysUnsupported("boxTransit", { info: { id: 1 }, isSupported: true }),
    false
  );
  // У отправления конверта нет — ответ приходит объектом, и трогать его нельзя.
  assert.strictEqual(RT.payloadSaysUnsupported("posting", { lozonId: 1 }), false);
});

module.exports = { tests };
