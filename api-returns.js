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

  // «Статус ALPS» на карточке — тоже код, который вёрстка переводит в подпись
  // (и у отправления, и у транзитной коробки это один и тот же словарь).
  const ALPS_STATUS_LABELS = {
    unknown: "Не определён",
    new: "Новый",
    moving: "В пути",
    waitingForSeller: "Готов к выдаче",
    waitingForDelivery: "Готов к доставке",
    completed: "Завершен",
    utilization: "Утилизируется",
    utilized: "Утилизирован",
    cancelled: "Отменен",
    writtenOff: "Списан",
    deficitRevealed: "Недостача",
    repackedIntoRpPosting: "В RP-постинге (устарел)",
    compensated: "Компенсирован",
    destroyed: "Расформирован",
    arrivedForResale: "Прибыл для перепродажи",
    movingToResale: "В пути для перепродажи",
  };

  const C2C_SCHEMA = "delivery";

  function text(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Подписи, подсмотренные на самой странице во время прогона: если бэкенд
  // завёл новый код, мы узнаём его перевод из карточки, прочитанной по DOM,
  // и дальше этот код обрабатывается быстрым чтением.
  const learnedStateLabels = {};
  const learnedSchemaLabels = {};
  const learnedAlpsLabels = {};

  function knownStateLabel(key) {
    if (Object.prototype.hasOwnProperty.call(LOZON_STATE_LABELS, key)) {
      return LOZON_STATE_LABELS[key];
    }
    if (Object.prototype.hasOwnProperty.call(learnedStateLabels, key)) {
      return learnedStateLabels[key];
    }
    return null;
  }

  function knownSchemaLabel(key) {
    if (Object.prototype.hasOwnProperty.call(DELIVERY_SCHEMA_LABELS, key)) {
      return DELIVERY_SCHEMA_LABELS[key];
    }
    if (Object.prototype.hasOwnProperty.call(learnedSchemaLabels, key)) {
      return learnedSchemaLabels[key];
    }
    return null;
  }

  function knownAlpsLabel(key) {
    if (Object.prototype.hasOwnProperty.call(ALPS_STATUS_LABELS, key)) {
      return ALPS_STATUS_LABELS[key];
    }
    if (Object.prototype.hasOwnProperty.call(learnedAlpsLabels, key)) {
      return learnedAlpsLabels[key];
    }
    return null;
  }

  function stateLabel(code) {
    const key = String(code ?? "").trim();
    if (!key) return "";
    const label = knownStateLabel(key);
    return label == null ? "" : label;
  }

  function alpsLabel(code) {
    const key = String(code ?? "").trim();
    if (!key) return "";
    const label = knownAlpsLabel(key);
    return label == null ? "" : label;
  }

  function hasUnknownAlpsCode(code) {
    const key = String(code ?? "").trim();
    if (!key) return false;
    return knownAlpsLabel(key) == null;
  }

  function schemaLabel(code) {
    const key = String(code ?? "").trim();
    if (!key) return "";
    const label = knownSchemaLabel(key);
    return label == null ? "" : label;
  }

  // Запоминаем перевод кода, увиденный на странице. Встроенный словарь никогда
  // не перезаписываем, пустые подписи не запоминаем.
  function learnStateLabel(code, label) {
    const key = String(code ?? "").trim();
    const value = text(label);
    if (!key || !value) return false;
    if (Object.prototype.hasOwnProperty.call(LOZON_STATE_LABELS, key)) return false;
    if (learnedStateLabels[key] === value) return false;
    learnedStateLabels[key] = value;
    return true;
  }

  function learnSchemaLabel(code, label) {
    const key = String(code ?? "").trim();
    const value = text(label);
    if (!key || !value) return false;
    if (Object.prototype.hasOwnProperty.call(DELIVERY_SCHEMA_LABELS, key)) return false;
    if (learnedSchemaLabels[key] === value) return false;
    learnedSchemaLabels[key] = value;
    return true;
  }

  function learnAlpsLabel(code, label) {
    const key = String(code ?? "").trim();
    const value = text(label);
    if (!key || !value) return false;
    if (Object.prototype.hasOwnProperty.call(ALPS_STATUS_LABELS, key)) return false;
    if (learnedAlpsLabels[key] === value) return false;
    learnedAlpsLabels[key] = value;
    return true;
  }

  // Неизвестный сервису код статуса — повод не доверять API по этому объекту:
  // на странице он отрисуется подписью, которой у нас нет.
  function hasUnknownStateCode(code) {
    const key = String(code ?? "").trim();
    if (!key) return false;
    return knownStateLabel(key) == null;
  }

  function hasUnknownSchemaCode(code) {
    const key = String(code ?? "").trim();
    if (!key) return false;
    return knownSchemaLabel(key) == null;
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

  // Последняя перевозка: на странице это отдельный блок, и DOM-скрейпер умеет
  // найти в нём наш опер. склад, когда текущее место — не наше.
  function lastCarriageRequest(articleType, articleId) {
    const id = encodeURIComponent(String(articleId ?? "").trim());
    switch (String(articleType || "").trim()) {
      case "posting":
        return { method: "GET", url: `${API_BASE}/Posting/last-carriage/${id}` };
      case "exemplar":
        return { method: "GET", url: `${API_BASE}/Exemplar/last-carriage/${id}` };
      case "boxTransit":
        return { method: "GET", url: `${API_BASE}/TransitBox/last-carriage/${id}` };
      default:
        return null;
    }
  }

  // Имена мест из последней перевозки — то, что видит скрейпер в её таблице.
  function carriagePlaceNames(carriage) {
    if (!carriage || typeof carriage !== "object") return [];
    return [carriage.sourcePlaceName, carriage.destinationPlaceName]
      .map((x) => text(x))
      .filter(Boolean);
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
    // «Статус ALPS» страница показывает только у непустого кода и тоже подписью.
    snap.statusAlps = alpsLabel(info.alpsStatus);
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
    snap.statusAlps = alpsLabel(info.alpsStatus);
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
    // Номенклатура коробки: живые прогоны дали оба варианта — на одних
    // карточках страница показывала товар из состава, на других «Транзитная
    // коробка» (так нормализация подписывает пустую номенклатуру). Пока не
    // видно, чем эти случаи отличаются, берём состав: это совпало на большей
    // выборке. Когда состав пуст, подпись поставит нормализация — как и на
    // чтении страницей.
    snap.nomenclature = firstNomenclature(content);
    snap.operationalWarehouse = text(places.currentPlace?.name);
    snap.operationalWarehouseSeen = Boolean(text(places.currentPlace?.name));
    snap.deliveryScheme = schemaLabel(schema);
    snap.formationWarehouse = text(places.sourcePlace?.name);
    // «Собственник» рисуется только когда у продавца есть id.
    snap.owner = main.sellerInfo?.id ? text(main.sellerInfo?.name) : "";
    snap.statusLozon = stateLabel(statuses.lozonState);
    // У коробки в «Статус ALPS» идёт returnStatus, и при unknown поле скрыто.
    const returnStatus = text(statuses.returnStatus);
    snap.statusAlps = returnStatus && returnStatus !== "unknown" ? alpsLabel(returnStatus) : "";
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

  // Достаёт из ответа коды, которые влияют на подписи, — чтобы и проверять их,
  // и уметь доучить перевод по странице.
  function codesFromInfo(articleType, info) {
    if (!info || typeof info !== "object") return null;
    const type = String(articleType || "").trim();
    if (type === "posting") {
      return {
        state: info.lozonState,
        schema: info.deliverySchema,
        alps: info.alpsStatus,
        id: info.lozonId,
      };
    }
    if (type === "exemplar") {
      return {
        state: info.lozonExemplarState,
        schema: info.deliverySchema,
        alps: info.alpsStatus,
        id: info.exemplarId,
      };
    }
    if (type === "boxTransit") {
      const box = info?.info && typeof info.info === "object" ? info.info : info;
      return {
        state: box?.statuses?.lozonState,
        schema: box?.mainInfo?.deliverySchema,
        alps: box?.statuses?.returnStatus,
        id: box?.id,
      };
    }
    return null;
  }

  // Перечисляет причины, по которым ответу нельзя доверять по этому объекту:
  // неизвестный код статуса/схемы (на странице будет подпись, которой у нас
  // нет) или потерявший точность id. Пустой список — можно доверять.
  function unknownCodesInInfo(articleType, info) {
    const codes = codesFromInfo(articleType, info);
    if (!codes) return [];
    const out = [];
    if (hasUnknownStateCode(codes.state)) out.push(`статус «${text(codes.state)}»`);
    if (hasUnknownSchemaCode(codes.schema)) out.push(`схема доставки «${text(codes.schema)}»`);
    if (hasUnknownAlpsCode(codes.alps)) out.push(`статус ALPS «${text(codes.alps)}»`);
    if (isUnsafeNumericId(codes.id)) out.push(`id вне точности (${codes.id})`);
    return out;
  }

  function snapshotHasUnknownCodes(articleType, info) {
    return unknownCodesInInfo(articleType, info).length > 0;
  }

  // Доучивание переводов по карточке, прочитанной со страницы: сопоставляем
  // код из ответа API с подписью, которую показала вёрстка.
  function learnLabelsFromDom(articleType, info, domData) {
    const codes = codesFromInfo(articleType, info);
    if (!codes || !domData || typeof domData !== "object") return [];
    const learned = [];
    if (learnStateLabel(codes.state, domData.statusLozon)) {
      learned.push(`${text(codes.state)} → «${text(domData.statusLozon)}»`);
    }
    if (learnSchemaLabel(codes.schema, domData.deliveryScheme)) {
      learned.push(`${text(codes.schema)} → «${text(domData.deliveryScheme)}»`);
    }
    if (learnAlpsLabel(codes.alps, domData.statusAlps)) {
      learned.push(`${text(codes.alps)} → «${text(domData.statusAlps)}»`);
    }
    return learned;
  }

  return {
    API_BASE,
    SUPPORTED_TYPES,
    LOZON_STATE_LABELS,
    DELIVERY_SCHEMA_LABELS,
    ALPS_STATUS_LABELS,
    C2C_SCHEMA,
    isSupportedType,
    stateLabel,
    schemaLabel,
    alpsLabel,
    hasUnknownStateCode,
    hasUnknownSchemaCode,
    hasUnknownAlpsCode,
    learnAlpsLabel,
    isUnsafeNumericId,
    snapshotHasUnknownCodes,
    unknownCodesInInfo,
    codesFromInfo,
    learnStateLabel,
    learnSchemaLabel,
    learnLabelsFromDom,
    resolveTypeRequest,
    infoRequest,
    contentRequest,
    lastCarriageRequest,
    carriagePlaceNames,
    firstNomenclature,
    emptySnapshot,
    mapUnsupported,
    mapPosting,
    mapExemplar,
    mapTransitBox,
    mapByType,
  };
});
