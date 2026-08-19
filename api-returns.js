// Знание об API returns.o3t.ru: какие ручки дергает сама страница карточки,
// как называются поля в ответах и какими подписями они отображаются в вёрстке.
// Всё выяснено по живому трафику (HAR) и по коду самого приложения, поэтому
// маппинг явный — угадывать ничего не нужно.
//
// Ручки (GET, база /p-api/alps-api):
//   ArticleProfile/ArticleResolver/get-article-type?article={номер или id}
//   ArticleProfile/Posting/info?id={id}      + Posting/posting-content/{id}
//   ArticleProfile/Exemplar/info?id={id}
//   ArticleProfile/TransitBox/info?id={id}   + TransitBox/content/{id}
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__gaApiReturns = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const API_BASE = "/p-api/alps-api/v1/ArticleProfile";

  // Профиль карточки умеет показывать только эти типы; на остальных страница
  // выводит информер «Неподдерживаемый тип», и наш DOM-скрейпер помечает такой
  // объект как unsupportedTransitBox.
  const SUPPORTED_TYPES = ["posting", "exemplar", "boxTransit"];

  // Подписи статусов ровно как в вёрстке (иначе паритет с DOM развалится).
  const LOZON_STATE_LABELS = {
    unknown: "Не определён",
    banded: "Сформирован",
    banding: "Формируется",
    disbanding: "Расформировывается",
    disbanded: "Расформирован",
    taken: "Прибыл в место назначения",
    lost: "Недостача",
    giveOutCourier: "Передано курьеру",
    giveOutClient: "Выдан клиенту",
    released: "Возвращен принципалу",
    changeDeliveryVariant: "Смена СД",
    giveOutClientRollback: "Отмена выдачи",
    bandedReturnRollback: "Отмена возврата",
    takenRollback: "Отмена прибытия",
    delivered: "Доставлен",
    writtenOff: "Списан",
    deleted: "Удален в источнике",
    transferred: "Передан принципалу",
    arrivedToPostomat: "Доставлен в постамат",
    cleanup: "Техническое удаление",
  };

  const DELIVERY_SCHEMA_LABELS = {
    unknown: "",
    fbs: "FBS",
    fbo: "FBO",
    retail: "Retail",
    principal: "Principal",
    crossBorder: "CrossBorder",
    delivery: "C2C", // схема delivery отображается как C2C
  };

  const C2C_SCHEMA = "delivery";

  function text(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stateLabel(code) {
    const key = String(code ?? "").trim();
    if (!key) return "";
    return Object.prototype.hasOwnProperty.call(LOZON_STATE_LABELS, key)
      ? LOZON_STATE_LABELS[key]
      : "";
  }

  function schemaLabel(code) {
    const key = String(code ?? "").trim();
    if (!key) return "";
    return Object.prototype.hasOwnProperty.call(DELIVERY_SCHEMA_LABELS, key)
      ? DELIVERY_SCHEMA_LABELS[key]
      : "";
  }

  // Неизвестный сервису код статуса — повод не доверять API по этому объекту:
  // на странице он отрисуется подписью, которой у нас нет.
  function hasUnknownStateCode(code) {
    const key = String(code ?? "").trim();
    if (!key) return false;
    return !Object.prototype.hasOwnProperty.call(LOZON_STATE_LABELS, key);
  }

  function hasUnknownSchemaCode(code) {
    const key = String(code ?? "").trim();
    if (!key) return false;
    return !Object.prototype.hasOwnProperty.call(DELIVERY_SCHEMA_LABELS, key);
  }

  function isSupportedType(articleType) {
    return SUPPORTED_TYPES.includes(String(articleType || "").trim());
  }

  // --- построение запросов ---------------------------------------------------

  function resolveTypeRequest(articleValue) {
    return {
      method: "GET",
      url: `${API_BASE}/ArticleResolver/get-article-type?article=${encodeURIComponent(
        String(articleValue ?? "").trim()
      )}`,
    };
  }

  function infoRequest(articleType, articleId) {
    const id = encodeURIComponent(String(articleId ?? "").trim());
    switch (String(articleType || "").trim()) {
      case "posting":
        return { method: "GET", url: `${API_BASE}/Posting/info?id=${id}` };
      case "exemplar":
        return { method: "GET", url: `${API_BASE}/Exemplar/info?id=${id}` };
      case "boxTransit":
        return { method: "GET", url: `${API_BASE}/TransitBox/info?id=${id}` };
      default:
        return null;
    }
  }

  // Номенклатура лежит отдельной ручкой — на странице это таблица «Состав».
  function contentRequest(articleType, articleId) {
    const id = encodeURIComponent(String(articleId ?? "").trim());
    switch (String(articleType || "").trim()) {
      case "posting":
        return { method: "GET", url: `${API_BASE}/Posting/posting-content/${id}` };
      case "boxTransit":
        return { method: "GET", url: `${API_BASE}/TransitBox/content/${id}` };
      default:
        return null; // у экземпляра номенклатура прямо в info
    }
  }

  // --- маппинг ---------------------------------------------------------------

  // Повторяет отбор строки из таблицы «Номенклатура» в DOM-скрейпере.
  function firstNomenclature(content) {
    const list = Array.isArray(content?.exemplars) ? content.exemplars : [];
    for (const ex of list) {
      const value = text(ex?.modelName);
      if (value.length < 2) continue;
      if (/^\d{10,}$/.test(value)) continue;
      if (/^[\d\s-]+$/.test(value) && value.replace(/\D/g, "").length > 12) continue;
      return value;
    }
    return "";
  }

  function priceValue(price) {
    const n = Number(price?.value);
    return Number.isFinite(n) ? n : null;
  }

  function emptySnapshot() {
    return {
      price: null,
      nomenclature: "",
      shipment: "",
      articleId: "",
      isTransitBox: false,
      isC2C: false,
      unsupportedTransitBox: false,
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

  // Страница с неподдерживаемым типом: кроме идентификатора на ней ничего нет.
  function mapUnsupported(articleId) {
    const snap = emptySnapshot();
    snap.articleId = text(articleId);
    snap.isTransitBox = true;
    snap.unsupportedTransitBox = true;
    return snap;
  }

  function mapPosting(info, content) {
    if (!info || typeof info !== "object") return null;
    const schema = String(info.deliverySchema ?? "").trim();
    const isC2C = schema === C2C_SCHEMA;
    const snap = emptySnapshot();
    snap.articleId = text(info.lozonId);
    snap.shipment = text(info.number);
    // У C2C страница не выводит ни сумму, ни собственника — повторяем это,
    // иначе строки уедут в другой ценовой диапазон.
    snap.price = isC2C ? null : priceValue(info.price);
    snap.nomenclature = firstNomenclature(content);
    snap.operationalWarehouse = text(info.currentWarehouseName);
    snap.operationalWarehouseSeen = Boolean(text(info.currentWarehouseName));
    snap.deliveryScheme = schemaLabel(schema);
    snap.formationWarehouse = text(info.formationWarehouseName);
    snap.owner = isC2C ? "" : text(info.contractCustomerName);
    snap.statusLozon = stateLabel(info.lozonState);
    snap.statusAlps = text(info.alpsStatus);
    snap.status = stateLabel(info.lozonState); // первый бейдж в шапке карточки
    snap.isC2C = isC2C;
    return snap;
  }

  function mapExemplar(info) {
    if (!info || typeof info !== "object") return null;
    const schema = String(info.deliverySchema ?? "").trim();
    const isC2C = schema === C2C_SCHEMA;
    const snap = emptySnapshot();
    snap.articleId = text(info.exemplarId);
    // Номера отправления в карточке экземпляра нет — подставится исходник.
    snap.shipment = "";
    snap.price = isC2C ? null : priceValue(info.price);
    snap.nomenclature = text(info.modelName);
    snap.operationalWarehouse = text(info.currentWarehouseName);
    snap.operationalWarehouseSeen = Boolean(text(info.currentWarehouseName));
    snap.deliveryScheme = schemaLabel(schema);
    snap.formationWarehouse = text(info.formationWarehouseName);
    snap.owner = isC2C ? "" : text(info.contractCustomerName);
    snap.statusLozon = stateLabel(info.lozonExemplarState);
    snap.statusAlps = text(info.alpsStatus);
    snap.status = stateLabel(info.lozonExemplarState);
    snap.isC2C = isC2C;
    return snap;
  }

  function mapTransitBox(payload, content) {
    const box = payload?.info && typeof payload.info === "object" ? payload.info : payload;
    if (!box || typeof box !== "object") return null;
    const main = box.mainInfo && typeof box.mainInfo === "object" ? box.mainInfo : {};
    const places = box.placeInfo && typeof box.placeInfo === "object" ? box.placeInfo : {};
    const statuses = box.statuses && typeof box.statuses === "object" ? box.statuses : {};
    const schema = String(main.deliverySchema ?? "").trim();
    const snap = emptySnapshot();
    snap.articleId = text(box.id);
    snap.shipment = text(main.returnInventoryId) || text(main.containerName);
    snap.price = priceValue(main.price);
    snap.nomenclature = firstNomenclature(content);
    snap.operationalWarehouse = text(places.currentPlace?.name);
    snap.operationalWarehouseSeen = Boolean(text(places.currentPlace?.name));
    snap.deliveryScheme = schemaLabel(schema);
    snap.formationWarehouse = text(places.sourcePlace?.name);
    // «Собственник» рисуется только когда у продавца есть id.
    snap.owner = main.sellerInfo?.id ? text(main.sellerInfo?.name) : "";
    snap.statusLozon = stateLabel(statuses.lozonState);
    const returnStatus = text(statuses.returnStatus);
    snap.statusAlps = returnStatus && returnStatus !== "unknown" ? returnStatus : "";
    snap.status = stateLabel(statuses.lozonState);
    snap.isTransitBox = true;
    snap.isC2C = schema === C2C_SCHEMA;
    return snap;
  }

  function mapByType(articleType, info, content) {
    switch (String(articleType || "").trim()) {
      case "posting":
        return mapPosting(info, content);
      case "exemplar":
        return mapExemplar(info);
      case "boxTransit":
        return mapTransitBox(info, content);
      default:
        return null;
    }
  }

  // JSON отдаёт идентификаторы числами: если такое число выходит за пределы
  // точного представления, строковый id со страницы и наш разойдутся.
  function isUnsafeNumericId(value) {
    return typeof value === "number" && Number.isFinite(value) && !Number.isSafeInteger(value);
  }

  // Признак «ответу нельзя доверять по этому объекту»: неизвестный код статуса
  // (на странице будет подпись, которой у нас нет) или потерявший точность id.
  // Такой объект дочитываем страницей.
  function snapshotHasUnknownCodes(articleType, info) {
    if (!info || typeof info !== "object") return false;
    const type = String(articleType || "").trim();
    if (type === "posting") {
      return (
        hasUnknownStateCode(info.lozonState) ||
        hasUnknownSchemaCode(info.deliverySchema) ||
        isUnsafeNumericId(info.lozonId)
      );
    }
    if (type === "exemplar") {
      return (
        hasUnknownStateCode(info.lozonExemplarState) ||
        hasUnknownSchemaCode(info.deliverySchema) ||
        isUnsafeNumericId(info.exemplarId)
      );
    }
    if (type === "boxTransit") {
      const box = info?.info && typeof info.info === "object" ? info.info : info;
      return (
        hasUnknownStateCode(box?.statuses?.lozonState) ||
        hasUnknownSchemaCode(box?.mainInfo?.deliverySchema) ||
        isUnsafeNumericId(box?.id)
      );
    }
    return false;
  }

  return {
    API_BASE,
    SUPPORTED_TYPES,
    LOZON_STATE_LABELS,
    DELIVERY_SCHEMA_LABELS,
    C2C_SCHEMA,
    isSupportedType,
    stateLabel,
    schemaLabel,
    hasUnknownStateCode,
    hasUnknownSchemaCode,
    isUnsafeNumericId,
    snapshotHasUnknownCodes,
    resolveTypeRequest,
    infoRequest,
    contentRequest,
    firstNomenclature,
    emptySnapshot,
    mapUnsupported,
    mapPosting,
    mapExemplar,
    mapTransitBox,
    mapByType,
  };
});
