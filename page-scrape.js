(function () {
  const LBL_SHIP = "\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435";
  const LBL_SHIP_NUM = "\u041d\u043e\u043c\u0435\u0440 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f";
  const LBL_SHIP_ID = "ID \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f";
  const LBL_NOM = "\u041d\u043e\u043c\u0435\u043d\u043a\u043b\u0430\u0442\u0443\u0440\u0430";
  const LBL_PACK = "\u0423\u043f\u0430\u043a\u043e\u0432\u043a\u0430 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f";
  const LBL_CUR_PLACE = "\u0422\u0435\u043a\u0443\u0449\u0435\u0435 \u043c\u0435\u0441\u0442\u043e";
  const LBL_DELIVERY_SCHEME = "\u0421\u0445\u0435\u043c\u0430 \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0438";
  const LBL_FORMATION_WH = "\u0421\u043a\u043b\u0430\u0434 \u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u044f";
  const LBL_OWNER = "\u0421\u043e\u0431\u0441\u0442\u0432\u0435\u043d\u043d\u0438\u043a";
  const LBL_STATUS_LOZON = "\u0421\u0442\u0430\u0442\u0443\u0441 lozon";
  const LBL_STATUS_ALPS = "\u0421\u0442\u0430\u0442\u0443\u0441 ALPS";

  function normText(s) {
    return String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeNamedValue(s) {
    const v = normText(s);
    if (!v) return "";
    const gluedAfterShortCode = v.match(/^(.+?_[0-9]{1,4})([0-9]{8,})$/);
    if (gluedAfterShortCode) return normText(gluedAfterShortCode[1]);
    const spacedId = v.match(/^(.+?)\s+([0-9]{8,})$/);
    if (spacedId) return normText(spacedId[1]);
    const generic = v.match(/^(.+\D)([0-9]{8,})$/);
    if (generic) return normText(generic[1]);
    return v;
  }

  function parseRussianMoneyNumber(text) {
    const raw = String(text)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const m = raw.match(/([\d\s\u00a0]+)[.,](\d{1,2})\s*₽/);
    if (m) {
      const intPart = m[1].replace(/[\s\u00a0]/g, "");
      return Number(`${intPart}.${m[2]}`);
    }
    const m2 = raw.match(/([\d\s\u00a0]+)[.,](\d{1,2})/);
    if (m2) {
      return Number(`${m2[1].replace(/[\s\u00a0]/g, "")}.${m2[2]}`);
    }
    return NaN;
  }

  function extractShipment(doc) {
    const bodyText = doc.body?.innerText || doc.body?.textContent || "";
    const norm = (s) => s.replace(/\u00a0/g, " ");

    const normalizeToken = (s) =>
      s
        .replace(/[),.;:]+$/g, "")
        .replace(/^[\s:—-]+/g, "")
        .trim();

    const pickShipmentToken = (text) => {
      const s = String(text || "").trim();
      if (!s) return "";
      const withPrefix = s.match(/\b[A-Za-zА-Яа-я0-9]+-\d{6,}(?:-[A-Za-zА-Яа-я0-9]+){1,6}\b/);
      if (withPrefix) return normalizeToken(withPrefix[0]);
      const numericLike = s.match(/\b\d{6,}(?:-\d+){1,4}\b/);
      if (numericLike) return normalizeToken(numericLike[0]);
      return normalizeToken(s.split(/\s+/)[0] || "");
    };

    const fromLines = (text) => {
      for (const line of norm(text).split(/\r?\n/)) {
        const t = line.trim();
        if (!t.includes(LBL_SHIP)) continue;
        const re = new RegExp(
          `${LBL_SHIP}\\s*[:\u2014\\-\\s]*\\s*(.+)$`,
          "i"
        );
        const m = t.match(re);
        if (m) {
          const rawTail = m[1].trim();
          const token = pickShipmentToken(rawTail);
          if (token.length >= 3) return token;
        }
      }
      return "";
    };

    let shipment = fromLines(bodyText);
    if (shipment) return shipment;

    const flat = norm(bodyText).replace(/\s+/g, " ");
    const reFlat = new RegExp(`${LBL_SHIP}\\s+(.+)`, "i");
    const m2 = flat.match(reFlat);
    if (m2) {
      const token = pickShipmentToken(m2[1]);
      if (token.length >= 3) return token;
    }

    const candidates = doc.querySelectorAll(
      "h1, h2, h3, [class*='headline'], [class*='header'], [class*='text-view']"
    );
    for (const el of candidates) {
      const t = norm(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t.includes(LBL_SHIP)) continue;
      const m = t.match(new RegExp(`${LBL_SHIP}\\s+(.+)$`, "i"));
      if (m) {
        const part = pickShipmentToken(m[1]);
        if (part.length >= 3) return part;
      }
    }

    const labels = doc.querySelectorAll("div, span, p");
    for (const el of labels) {
      const label = norm(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (label !== "номер транзитной коробки") continue;
      const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow'], div");
      if (!row) continue;
      const contentRoot =
        row.querySelector("[class*='_content'], [class*='content']") ||
        el.nextElementSibling ||
        row;
      const copyable = contentRoot.querySelector("[class*='_copyableText'], div");
      const token = normalizeToken((copyable?.textContent || "").split(/\s+/)[0] || "");
      if (token.length >= 4) return token;
    }

    const transitCandidates = doc.querySelectorAll("h1, h2, h3, div, span");
    for (const el of transitCandidates) {
      const t = norm(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || !t.toLowerCase().includes("транзитная коробка")) continue;
      const m = t.match(/транзитная коробка\s+([^\s,;]+)/i);
      if (m && m[1]) return normalizeToken(m[1]);
      const parts = t.split(/\s+/);
      const last = parts[parts.length - 1] || "";
      if (last.length >= 4) return normalizeToken(last);
    }

    const postingTables = doc.querySelectorAll("table");
    for (const table of postingTables) {
      const headers = [...table.querySelectorAll("thead th")].map((th) =>
        norm(th.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()
      );
      const idCol = headers.findIndex((h) => h.includes("id, номер"));
      if (idCol < 0) continue;
      const rows = [...table.querySelectorAll("tbody tr")];
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")];
        if (idCol >= cells.length) continue;
        const cell = cells[idCol];
        const links = [...cell.querySelectorAll("a")].map((a) => normalizeToken(a.textContent || ""));
        for (const token of links) {
          if (/^[A-Za-zА-Яа-я0-9]+-\d{4,}(?:-[A-Za-zА-Яа-я0-9]+){1,6}$/.test(token)) return token;
          if (/^\d{6,}(?:-\d+){1,4}$/.test(token)) return token;
        }
        const text = normalizeToken(cell.textContent || "");
        const m = text.match(/[A-Za-zА-Яа-я0-9]+-\d{4,}(?:-[A-Za-zА-Яа-я0-9]+){1,6}|\d{6,}(?:-\d+){1,4}/);
        if (m) return normalizeToken(m[0]);
      }
    }

    const allLinks = doc.querySelectorAll("a");
    for (const a of allLinks) {
      const txt = normalizeToken(a.textContent || "");
      if (!txt) continue;
      if (/^[A-Za-zА-Яа-я0-9]+-\d{4,}(?:-[A-Za-zА-Яа-я0-9]+){1,6}$/.test(txt)) return txt;
      if (/^\d{6,}(?:-\d+){1,4}$/.test(txt)) return txt;
    }

    return "";
  }

  function extractNomenclature(doc) {
    const tables = doc.querySelectorAll("table");
    for (const table of tables) {
      const ths = [...table.querySelectorAll("thead th")];
      const nomIdx = ths.findIndex((th) => {
        const x = (th.textContent || "").replace(/\s+/g, " ").trim();
        return x.includes(LBL_NOM);
      });
      if (nomIdx === -1) continue;

      const rows = [...table.querySelectorAll("tbody tr")];
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")];
        if (nomIdx >= cells.length) continue;
        const cell = cells[nomIdx];
        const text = (cell.innerText || cell.textContent || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length < 2) continue;
        if (/^\d{10,}$/.test(text)) continue;
        if (/^[\d\s-]+$/.test(text) && text.replace(/\D/g, "").length > 12) {
          continue;
        }
        return text;
      }
    }

    const labels = doc.querySelectorAll("div, span, p");
    for (const el of labels) {
      const label = (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (label !== "номенклатура") continue;
      const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow'], div");
      if (!row) continue;
      const contentRoot =
        row.querySelector("[class*='_content'], [class*='content']") ||
        el.nextElementSibling ||
        row;
      const text = (contentRoot.innerText || contentRoot.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length >= 2) return text;
    }
    return "";
  }

  function extractPrice(doc) {
    let price = NaN;

    const labels = doc.querySelectorAll("div, span, p");
    for (const el of labels) {
      const label = (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (label !== "сумма") continue;
      const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow'], div");
      if (!row) continue;
      const contentRoot =
        row.querySelector("[class*='_content'], [class*='content']") ||
        el.nextElementSibling ||
        row;
      const n = parseRussianMoneyNumber(contentRoot.textContent || "");
      if (!Number.isNaN(n)) return n;
    }

    doc.querySelectorAll("div, span, p").forEach((el) => {
      if (!Number.isNaN(price)) return;
      const t = (el.textContent || "").replace(/\u00a0/g, " ");
      if (!t.includes(LBL_PACK)) return;
      if (!t.includes("₽") && !/руб/i.test(t)) return;
      const n = parseRussianMoneyNumber(t);
      if (!Number.isNaN(n)) price = n;
    });

    if (Number.isNaN(price)) {
      const bodyText = doc.body?.innerText || "";
      const idx = bodyText.indexOf(LBL_PACK);
      if (idx !== -1) {
        price = parseRussianMoneyNumber(bodyText.slice(idx, idx + 220));
      }
    }

    if (Number.isNaN(price)) {
      const labels = doc.querySelectorAll("div, span, p");
      for (const el of labels) {
        const label = (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        if (label !== "цена") continue;
        const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow'], div");
        if (!row) continue;
        const contentRoot =
          row.querySelector("[class*='_content'], [class*='content']") ||
          el.nextElementSibling ||
          row;
        const n = parseRussianMoneyNumber(contentRoot.textContent || "");
        if (!Number.isNaN(n)) {
          price = n;
          break;
        }
      }
    }

    return price;
  }

  function extractGridProperty(doc, labelText) {
    const targetLabel = normText(labelText).toLowerCase();
    const labels = doc.querySelectorAll("div, span, p");
    for (const el of labels) {
      const t = normText(el.textContent);
      if (!t || t.toLowerCase() !== targetLabel) continue;
      const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow']");
      if (!row) continue;
      const contentRoot =
        row.querySelector("[class*='_content'], [class*='content']") || el.nextElementSibling || row;

      const badgeWrap = contentRoot.querySelector("[class*='badge__badge']");
      if (badgeWrap) {
        const byTitle = normText(badgeWrap.getAttribute("title") || "");
        if (byTitle) return byTitle;
      }
      const badgeLabel = contentRoot.querySelector("[class*='badge__label']");
      if (badgeLabel) {
        const badgeVal = normText(badgeLabel.textContent);
        if (badgeVal) return badgeVal;
      }

      const mainEl = contentRoot.querySelector(
        "div[class*='paragraph-medium'][class*='paddingBottomOff'], div[class*='paragraph-medium'][class*='paddingTopOff']"
      );
      const mainVal = sanitizeNamedValue(mainEl?.textContent || "");
      if (mainVal && mainVal.toLowerCase() !== targetLabel) return mainVal;

      for (const c of contentRoot.querySelectorAll("div, span, p")) {
        const v = sanitizeNamedValue(c.textContent);
        if (!v || v.toLowerCase() === targetLabel) continue;
        if (/^\d{8,}$/.test(v)) continue;
        if (/[А-Яа-яA-Za-z]/.test(v)) return v;
      }

      // Значение может лежать прямо в контейнере, без вложенного div/span/p —
      // так на карточке отправления нарисован «Собственник», и по замерам он
      // терялся на всех отправлениях подряд. querySelectorAll сам контейнер не
      // возвращает, поэтому его текст берём отдельно, отрезав подпись, если она
      // попала в тот же узел.
      const ownText = normText(contentRoot.innerText || contentRoot.textContent || "");
      const withoutLabel = ownText.toLowerCase().startsWith(targetLabel)
        ? normText(ownText.slice(targetLabel.length))
        : ownText;
      const ownVal = sanitizeNamedValue(withoutLabel);
      if (
        ownVal &&
        ownVal.toLowerCase() !== targetLabel &&
        !/^\d{8,}$/.test(ownVal) &&
        /[А-Яа-яA-Za-z]/.test(ownVal)
      ) {
        return ownVal;
      }
    }
    return "";
  }

  function extractCopyableFromRow(row) {
    if (!row) return "";
    const contentRoot =
      row.querySelector("[class*='_content'], [class*='content']") || row;
    const copyable = contentRoot.querySelector("[class*='_copyableText'], [class*='copyableText']");
    if (copyable) {
      const clone = copyable.cloneNode(true);
      clone.querySelectorAll("button, svg").forEach((n) => n.remove());
      const token = normText(clone.textContent || "").split(/\s+/)[0] || "";
      if (token) return token;
    }
    const text = normText(contentRoot.textContent || "");
    const m = text.match(/[A-Za-z0-9%._-]{6,}/);
    return m ? m[0] : "";
  }

  function isLikelyLozonIdValue(v) {
    const s = normText(v).replace(/\s+/g, "");
    return /^\d{10,35}$/.test(s);
  }

  function isIdFieldLabel(low) {
    if (!low) return false;
    if (low.startsWith("номер")) return false;
    if (low.includes("штрихкод") || low.includes("barcode")) return false;
    
    if (/^id(\s|$|:)/i.test(low)) return true;
    if (/\bid\b/.test(low) && (
      low.includes("отправлен") ||
      low.includes("постинг") ||
      low.includes("предмет") ||
      low.includes("коробк")
    )) {
      return true;
    }
    return false;
  }

  function extractGridValueByLabel(doc, labelText) {
    const target = normText(labelText).toLowerCase();
    if (!target) return "";
    const labels = doc.querySelectorAll("div, span, p, dt, th, label");
    for (const el of labels) {
      const t = normText(el.textContent);
      if (!t || t.toLowerCase() !== target) continue;
      const row =
        el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow']") ||
        el.parentElement;
      const token = extractCopyableFromRow(row);
      if (token) return token;
      const sib = el.nextElementSibling;
      if (sib) {
        const fromSib = extractCopyableFromRow(sib) || normText(sib.textContent).split(/\s+/)[0];
        if (fromSib) return fromSib;
      }
    }
    return "";
  }

  function extractArticleIdFromPage(doc) {
    const preferredLabels = [
      LBL_SHIP_ID,
      "ID транзитной коробки",
      "ID постинга",
      "ID предмета",
    ];
    for (const label of preferredLabels) {
      const token = extractGridValueByLabel(doc, label);
      if (isLikelyLozonIdValue(token)) return token;
    }

    const labels = doc.querySelectorAll("div, span, p, dt, th, label");
    const scored = [];
    for (const el of labels) {
      const label = normText(el.textContent);
      if (!label || label.length > 80) continue;
      const low = label.toLowerCase();
      if (!isIdFieldLabel(low)) continue;
      const row =
        el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow']") ||
        el.parentElement;
      const token = extractCopyableFromRow(row);
      if (!isLikelyLozonIdValue(token)) continue;
      let score = 10;
      if (low.includes("id отправления")) score += 100;
      if (low.includes("id транзитной коробки")) score += 100;
      if (low.includes("id постинга")) score += 40;
      if (low.includes("коробк")) score += 30;
      scored.push({ score, token });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) return scored[0].token;

    
    const links = doc.querySelectorAll("a[href]");
    for (const a of links) {
      const href = String(a.getAttribute("href") || "");
      const m =
        href.match(/Lozon:(\d{10,35})/i) ||
        href.match(/[?&]articleIdOrBarcode=(\d{10,35})/i) ||
        href.match(/\/tracking\/(\d{10,35})/i);
      if (m && isLikelyLozonIdValue(m[1])) return m[1];
    }
    return "";
  }

  function extractShipmentNumberFromGrid(doc) {
    const preferredLabels = [
      LBL_SHIP_NUM,
      "Номер постинга",
      "Номер транзитной коробки",
    ];
    for (const label of preferredLabels) {
      const token = extractGridValueByLabel(doc, label);
      if (token.length >= 3) return token;
    }
    return "";
  }

  function detectIsC2C(doc) {
    const text = String(doc.body?.innerText || "").replace(/\u00a0/g, " ");
    const hasC2CToken = /\bC2C\b/i.test(text) || /с2с/i.test(text);
    if (!hasC2CToken) return false;
    return (
      text.includes("Номенклатура") ||
      text.includes("Основная информация") ||
      text.includes("Схема доставки")
    );
  }

  const UNSUPPORTED_TYPE_MARKER = "Неподдерживаемый тип";

  function textHasUnsupportedItemMarker(text) {
    return normText(text).includes(UNSUPPORTED_TYPE_MARKER);
  }

  function detectUnsupportedTransitBox(doc) {
    if (textHasUnsupportedItemMarker(doc.body?.innerText || doc.body?.textContent || "")) {
      return true;
    }
    const nodes = doc.querySelectorAll(
      "[class*='informer'], [class*='Informer'], [class*='ozi__informer']"
    );
    for (const el of nodes) {
      if (textHasUnsupportedItemMarker(el.textContent)) return true;
    }
    return false;
  }

  function extractFromDocument(doc, opsWarehouses) {
    const articleId = extractArticleIdFromPage(doc);
    if (detectUnsupportedTransitBox(doc)) {
      return {
        price: null,
        nomenclature: "",
        shipment: "",
        articleId,
        isTransitBox: true,
        isC2C: false,
        unsupportedTransitBox: true,
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
    const shipmentFromGrid = extractShipmentNumberFromGrid(doc);
    const shipment = shipmentFromGrid || extractShipment(doc);
    const bodyText = String(doc.body?.innerText || "");
    const isTransitBox =
      bodyText.includes("Номер транзитной коробки") ||
      bodyText.includes("Транзитная коробка");
    const isC2C = !isTransitBox && detectIsC2C(doc);
    const opsInfo = resolveOperationalWarehouse(doc, opsWarehouses);
    return {
      price: extractPrice(doc),
      nomenclature: extractNomenclature(doc),
      shipment,
      articleId,
      isTransitBox,
      isC2C,
      unsupportedTransitBox: false,
      operationalWarehouse: opsInfo.matched,
      operationalWarehouseSeen: Boolean(opsInfo.seen),
      deliveryScheme: extractGridProperty(doc, LBL_DELIVERY_SCHEME),
      formationWarehouse: extractGridProperty(doc, LBL_FORMATION_WH),
      owner: extractGridProperty(doc, LBL_OWNER),
      status: extractStatus(doc),
      statusLozon: extractGridProperty(doc, LBL_STATUS_LOZON),
      statusAlps: extractGridProperty(doc, LBL_STATUS_ALPS),
    };
  }

  function resolveOperationalWarehouse(doc, opsWarehouses) {
    const norm = normText;
    const sanitizePlace = sanitizeNamedValue;
    const knownWarehouses = Array.isArray(opsWarehouses)
      ? opsWarehouses.map((x) => norm(x)).filter(Boolean)
      : [];
    const matchKnownWarehouse = (text) => {
      const t = norm(text);
      if (!t || knownWarehouses.length === 0) return "";
      for (const w of knownWarehouses) {
        if (t === w) return w;
      }
      const parts = t.split(/\s+[—-]\s+/).map((x) => norm(x)).filter(Boolean);
      for (const p of parts) {
        for (const w of knownWarehouses) {
          if (p === w) return w;
        }
      }
      return "";
    };

    let seen = false;
    let matched = "";

    const considerPlace = (raw) => {
      const v = sanitizePlace(raw);
      if (!v || v.toLowerCase() === LBL_CUR_PLACE.toLowerCase()) return false;
      if (/^\d{8,}$/.test(v)) return false;
      if (v.toLowerCase().startsWith(LBL_CUR_PLACE.toLowerCase())) return false;
      if (!/[А-Яа-яA-Za-z]/.test(v)) return false;
      seen = true;
      if (knownWarehouses.length === 0) {
        if (!matched) matched = v;
        return true;
      }
      if (!matched) {
        const m = matchKnownWarehouse(v);
        if (m) {
          matched = m;
          return true;
        }
      }
      return Boolean(matched);
    };

    const labels = doc.querySelectorAll("div, span, p");
    for (const el of labels) {
      const t = norm(el.textContent);
      if (!t) continue;
      if (t.toLowerCase() !== LBL_CUR_PLACE.toLowerCase()) continue;
      const row = el.closest("[class*='propertiesGridRow'], [class*='_propertiesGridRow'], div");
      if (!row) continue;
      const contentRoot =
        row.querySelector("[class*='_content'], [class*='content']") ||
        el.nextElementSibling ||
        row;
      const mainPlaceEl = contentRoot.querySelector(
        "div[class*='paragraph-medium'][class*='paddingBottomOff']"
      );
      if (considerPlace(mainPlaceEl?.textContent || "") && matched) {
        return { matched, seen };
      }
      const candidates = contentRoot.querySelectorAll("div, span, p");
      for (const c of candidates) {
        if (considerPlace(c.textContent) && matched) {
          return { matched, seen };
        }
      }
      // Место тоже может лежать прямо в контейнере, без вложенного узла: тогда
      // querySelectorAll его не отдаёт и склад выглядел бы «не найденным на
      // странице», а такой объект уходит в ошибки вместо пропуска.
      if (considerPlace(contentRoot.innerText || contentRoot.textContent || "") && matched) {
        return { matched, seen };
      }
    }

    if (knownWarehouses.length > 0) {
      const islands = doc.querySelectorAll("div");
      for (const island of islands) {
        const islandText = norm(island.innerText || island.textContent || "");
        if (!islandText.includes("Последняя перевозка")) continue;
        const routeCells = island.querySelectorAll(
          "td[class*='_tableCellRoute'], td"
        );
        for (const cell of routeCells) {
          const m = matchKnownWarehouse(cell.textContent || "");
          if (m) return { matched: m, seen: true };
        }
      }
    }

    if (knownWarehouses.length === 0 && !matched) {
      const bodyText = norm(doc.body?.innerText || "");
      const idx = bodyText.toLowerCase().indexOf(LBL_CUR_PLACE.toLowerCase());
      if (idx >= 0) {
        const tail = bodyText.slice(idx + LBL_CUR_PLACE.length).replace(/^[:\s-]+/, "");
        const first = tail.split(/\s{2,}|\n/)[0]?.trim() || "";
        if (first && !/^\d{8,}$/.test(first)) {
          seen = true;
          matched = first;
        }
      }
    }
    return { matched, seen };
  }

  function extractOperationalWarehouse(doc, opsWarehouses) {
    return resolveOperationalWarehouse(doc, opsWarehouses).matched;
  }

  function extractStatus(doc) {
    const badgeLabel = doc.querySelector(
      "[class*='badge__badge'] [class*='badge__label']"
    );
    const badgeWrap = badgeLabel?.closest("[class*='badge__badge']");
    const byTitle = (badgeWrap?.getAttribute("title") || "").trim();
    const byLabel = (badgeLabel?.textContent || "").replace(/\s+/g, " ").trim();
    if (byTitle) return byTitle;
    if (byLabel) return byLabel;

    const genericBadge = doc.querySelector("[class*='badge'][title]");
    const genericTitle = (genericBadge?.getAttribute("title") || "").trim();
    if (genericTitle) return genericTitle;

    return "";
  }

  globalThis.__returnsReadPage = function (opsWarehouses) {
    return extractFromDocument(document, opsWarehouses);
  };
})();
