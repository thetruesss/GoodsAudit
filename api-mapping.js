// Чистая логика перевода чтения карточек со скрейпинга DOM на API:
// разбор перехваченного трафика страницы, обучение шаблона запроса и маппинга
// полей по DOM-эталону, экстракция, лимитер нагрузки и машина состояний.
// Никакого ввода-вывода и chrome.* — модуль работает и в service worker
// (importScripts), и в Node (require) для тестов.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__gaApiMapping = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ID_MARKER_RAW = "\u0000GA_ID\u0000";
  const ID_MARKER_ENC = "\u0000GA_ID_ENC\u0000";
  const MAX_JSON_NODES = 30000;
  const MAX_JSON_DEPTH = 14;

  // Поля «сырого снапшота» — ровно те, что возвращает DOM-скрейпер страницы.
  const SCRAPE_FIELDS = [
    "price",
    "nomenclature",
    "shipment",
    "articleId",
    "operationalWarehouse",
    "deliveryScheme",
    "formationWarehouse",
    "owner",
    "status",
    "statusLozon",
    "statusAlps",
  ];
  // Без этих полей API-путь не имеет смысла — не включаемся.
  const CORE_FIELDS = ["price", "nomenclature", "shipment", "articleId"];

  const AUTH_HEADER_NAMES = ["authorization"];
  const AUTH_HEADER_PREFIXES = ["x-o3-", "x-csrf", "x-xsrf", "x-auth"];

  function normalizeCompareText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseLooseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const s = String(value ?? "")
      .replace(/[\s\u00a0]/g, "")
      .replace(",", ".");
    if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function valuesEqualLoose(a, b) {
    const na = normalizeCompareText(a);
    const nb = normalizeCompareText(b);
    if (na === nb) return true;
    const fa = parseLooseNumber(a);
    const fb = parseLooseNumber(b);
    if (Number.isFinite(fa) && Number.isFinite(fb)) return fa === fb;
    return false;
  }

  function collectJsonPaths(rootValue) {
    const out = [];
    const stack = [{ value: rootValue, path: [] }];
    let nodes = 0;
    while (stack.length) {
      const { value, path } = stack.pop();
      nodes += 1;
      if (nodes > MAX_JSON_NODES || path.length > MAX_JSON_DEPTH) continue;
      if (value == null) continue;
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") {
        out.push({ path, value });
        continue;
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          stack.push({ value: value[i], path: path.concat(i) });
        }
        continue;
      }
      if (t === "object") {
        for (const key of Object.keys(value)) {
          stack.push({ value: value[key], path: path.concat(key) });
        }
      }
    }
    return out;
  }

  function getByPath(rootValue, path) {
    let cur = rootValue;
    for (const seg of Array.isArray(path) ? path : []) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function isBoundaryChar(ch) {
    return !/[0-9A-Za-z_-]/.test(ch || "");
  }

  // Заменяет вхождения ID (по границам слова) на маркер. Возвращает
  // { text, count } — count = сколько замен сделано.
  function replaceIdOccurrences(text, id, marker) {
    const s = String(text ?? "");
    const needle = String(id ?? "");
    if (!s || !needle) return { text: s, count: 0 };
    let out = "";
    let i = 0;
    let count = 0;
    while (i < s.length) {
      const idx = s.indexOf(needle, i);
      if (idx < 0) {
        out += s.slice(i);
        break;
      }
      const before = idx === 0 ? "" : s[idx - 1];
      const afterIdx = idx + needle.length;
      const after = afterIdx >= s.length ? "" : s[afterIdx];
      if (isBoundaryChar(before) && isBoundaryChar(after)) {
        out += s.slice(i, idx) + marker;
        count += 1;
        i = afterIdx;
      } else {
        out += s.slice(i, afterIdx);
        i = afterIdx;
      }
    }
    return { text: out, count };
  }

  function buildRequestTemplate(entry, articleId) {
    const id = String(articleId ?? "").trim();
    if (!entry || !id) return null;
    const method = String(entry.method || "GET").toUpperCase();
    const encId = encodeURIComponent(id);

    let url = String(entry.url || "");
    let urlCount = 0;
    if (encId !== id) {
      const encPass = replaceIdOccurrences(url, encId, ID_MARKER_ENC);
      url = encPass.text;
      urlCount += encPass.count;
    }
    const rawPass = replaceIdOccurrences(url, id, ID_MARKER_RAW);
    url = rawPass.text;
    urlCount += rawPass.count;

    let body = entry.body == null ? null : String(entry.body);
    let bodyCount = 0;
    if (body != null) {
      if (encId !== id) {
        const encPass = replaceIdOccurrences(body, encId, ID_MARKER_ENC);
        body = encPass.text;
        bodyCount += encPass.count;
      }
      const rawBody = replaceIdOccurrences(body, id, ID_MARKER_RAW);
      body = rawBody.text;
      bodyCount += rawBody.count;
    }

    if (urlCount + bodyCount === 0) return null;
    return { method, urlTemplate: url, bodyTemplate: body };
  }

  function applyRequestTemplate(template, articleId) {
    const id = String(articleId ?? "").trim();
    if (!template || !id) return null;
    const sub = (s) =>
      s == null
        ? null
        : String(s)
            .split(ID_MARKER_ENC)
            .join(encodeURIComponent(id))
            .split(ID_MARKER_RAW)
            .join(id);
    return {
      method: template.method || "GET",
      url: sub(template.urlTemplate),
      body: sub(template.bodyTemplate),
    };
  }

  function filterAuthHeaders(headers) {
    const out = {};
    const src = headers && typeof headers === "object" ? headers : {};
    for (const name of Object.keys(src)) {
      const low = String(name).toLowerCase();
      if (
        AUTH_HEADER_NAMES.includes(low) ||
        AUTH_HEADER_PREFIXES.some((p) => low.startsWith(p))
      ) {
        out[low] = String(src[name]);
      }
    }
    return out;
  }

  // Ищет в списке перехваченных записей (новые в конце) свежие авторизационные
  // заголовки. Возвращает {} если ничего похожего не нашлось.
  function latestAuthHeaders(entries) {
    const list = Array.isArray(entries) ? entries : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const auth = filterAuthHeaders(list[i]?.headers);
      if (Object.keys(auth).length) return auth;
    }
    return {};
  }

  function parseEntryJson(entry) {
    const text = String(entry?.responseText || "");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function nonEmptySnapshotFields(snapshot) {
    const out = [];
    for (const field of SCRAPE_FIELDS) {
      const v = snapshot?.[field];
      if (field === "price") {
        if (Number.isFinite(Number(v))) out.push(field);
        continue;
      }
      if (normalizeCompareText(v)) out.push(field);
    }
    return out;
  }

  // Обучение на первом объекте: ищем среди перехваченных ответов тот, где
  // лежат значения DOM-снапшота, и который можно параметризовать нашим ID.
  // Возвращает кандидата с шаблоном запроса и наборами путей-кандидатов на
  // каждое поле (окончательный выбор — после сверки на втором объекте).
  function learnFromEntries(entries, articleId, snapshot) {
    const list = Array.isArray(entries) ? entries : [];
    const fields = nonEmptySnapshotFields(snapshot);
    if (!fields.length) return null;
    let best = null;
    for (const entry of list) {
      if (!entry || (Number(entry.status) || 0) !== 200) continue;
      const template = buildRequestTemplate(entry, articleId);
      if (!template) continue;
      const json = parseEntryJson(entry);
      if (json == null) continue;
      const paths = collectJsonPaths(json);
      const fieldCandidates = {};
      let matched = 0;
      for (const field of fields) {
        const expected = snapshot[field];
        const cands = [];
        for (const p of paths) {
          if (valuesEqualLoose(p.value, expected)) cands.push(p.path);
        }
        if (cands.length) {
          // Короткие пути надёжнее глубинных совпадений.
          cands.sort((a, b) => a.length - b.length);
          fieldCandidates[field] = cands.slice(0, 12);
          matched += 1;
        }
      }
      const coreMatched = CORE_FIELDS.every((f) =>
        fields.includes(f) ? Boolean(fieldCandidates[f]) : true
      );
      if (!coreMatched || matched < Math.min(4, fields.length)) continue;
      const score = matched * 1000 - String(entry.responseText || "").length / 100000;
      if (!best || score > best.score) {
        best = {
          score,
          template,
          fieldCandidates,
          entryUrl: String(entry.url || ""),
        };
      }
    }
    if (!best) return null;
    return {
      template: best.template,
      fieldCandidates: best.fieldCandidates,
      entryUrl: best.entryUrl,
    };
  }

  // Сверка на втором объекте: для каждого поля оставляем путь, значение по
  // которому совпадает с DOM-эталоном второго объекта. Требуем покрыть все
  // непустые поля второго снапшота и все базовые поля.
  function refineMapping(fieldCandidates, json2, snapshot2) {
    const required = nonEmptySnapshotFields(snapshot2);
    for (const core of CORE_FIELDS) {
      if (!required.includes(core)) required.push(core);
    }
    const mapping = {};
    const mismatches = [];
    for (const field of required) {
      const expected = snapshot2?.[field];
      const cands = Array.isArray(fieldCandidates?.[field]) ? fieldCandidates[field] : [];
      let chosen = null;
      for (const path of cands) {
        const got = getByPath(json2, path);
        if (valuesEqualLoose(got, expected)) {
          chosen = path;
          break;
        }
      }
      if (!chosen) {
        mismatches.push(field);
        continue;
      }
      mapping[field] = { path: chosen, kind: field === "price" ? "number" : "string" };
    }
    if (mismatches.length) return { ok: false, mismatches };
    return { ok: true, mapping };
  }

  // Извлечение снапшота по обученному маппингу. Непокрытые поля — пустые
  // строки; невозможность прочитать ОБУЧЕННОЕ поле — отказ (объект уйдёт в DOM).
  function extractSnapshotByMapping(json, mapping) {
    const snapshot = {};
    const missing = [];
    for (const field of SCRAPE_FIELDS) {
      const m = mapping?.[field];
      if (!m) {
        snapshot[field] = field === "price" ? 0 : "";
        continue;
      }
      const raw = getByPath(json, m.path);
      if (m.kind === "number") {
        const n = parseLooseNumber(raw);
        if (!Number.isFinite(n)) {
          missing.push(field);
          continue;
        }
        snapshot[field] = n;
        continue;
      }
      if (raw == null) {
        snapshot[field] = "";
        continue;
      }
      if (typeof raw === "object") {
        missing.push(field);
        continue;
      }
      snapshot[field] = normalizeCompareText(raw);
    }
    if (missing.length) return { ok: false, missing };
    return { ok: true, snapshot };
  }

  function snapshotsMatch(a, b, fields) {
    const list = Array.isArray(fields) && fields.length ? fields : SCRAPE_FIELDS;
    const mismatches = [];
    for (const field of list) {
      if (!valuesEqualLoose(a?.[field], b?.[field])) mismatches.push(field);
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  // Зеркало resolveOperationalWarehouse из page-scrape.js: сопоставляет сырое
  // значение склада со списком опер. складов пользователя. Возвращает
  // { matched, seen } — matched — совпавший склад (или сырое значение без
  // фильтра, или "" если склад есть, но не наш); seen — был ли склад вообще.
  function resolveOpsWarehouse(rawValue, opsList) {
    const raw = normalizeCompareText(rawValue);
    const known = (Array.isArray(opsList) ? opsList : [])
      .map((x) => normalizeCompareText(x))
      .filter(Boolean);
    if (!raw) return { matched: "", seen: false };
    if (/^\d{8,}$/.test(raw)) return { matched: "", seen: false };
    if (known.length === 0) return { matched: raw, seen: true };
    if (known.includes(raw)) return { matched: raw, seen: true };
    const parts = raw.split(/\s+[—-]\s+/).map((x) => normalizeCompareText(x)).filter(Boolean);
    for (const p of parts) {
      if (known.includes(p)) return { matched: p, seen: true };
    }
    return { matched: "", seen: true };
  }

  function extractedSnapshotLooksSane(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (!Number.isFinite(Number(snapshot.price))) return false;
    if (!normalizeCompareText(snapshot.nomenclature)) return false;
    if (!normalizeCompareText(snapshot.articleId) && !normalizeCompareText(snapshot.shipment)) {
      return false;
    }
    return true;
  }

  // Общий на все окна ограничитель нагрузки (токен-бакет, асинхронный).
  function createRequestPacer(rps) {
    const rate = Math.max(0, Number(rps) || 0);
    let nextFree = 0;
    return {
      async take(n = 1) {
        if (rate <= 0) return;
        const cost = (Math.max(1, Math.floor(n)) / rate) * 1000;
        const now = Date.now();
        const start = Math.max(now, nextFree);
        nextFree = start + cost;
        const wait = start - now;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      },
    };
  }

  // Машина состояний probe → on → off с переучиванием после 401 и защитой
  // от тихого расхождения (контрольные сверки).
  function createApiModeController(opts = {}) {
    const maxProbeFails = Math.max(1, Number(opts.maxProbeFails) || 2);
    const maxRelearnFails = Math.max(1, Number(opts.maxRelearnFails) || 2);
    const maxMiscompares = Math.max(1, Number(opts.maxMiscompares) || 2);
    const st = {
      phase: "probe",
      reason: "",
      probeFails: 0,
      relearnFails: 0,
      miscompares: 0,
      awaitingRelearn: false,
      postRelearn: false,
    };
    const off = (reason) => {
      st.phase = "off";
      st.reason = String(reason || "");
    };
    return {
      getPhase: () => st.phase,
      getReason: () => st.reason,
      probeFail(reason) {
        if (st.phase !== "probe") return st.phase;
        st.probeFails += 1;
        if (st.probeFails >= maxProbeFails) off(reason || "probe-failed");
        return st.phase;
      },
      probeSuccess() {
        if (st.phase === "probe") st.phase = "on";
        return st.phase;
      },
      batch401() {
        if (st.phase !== "on") return st.phase;
        if (st.postRelearn) {
          st.relearnFails += 1;
          st.postRelearn = false;
          if (st.relearnFails >= maxRelearnFails) {
            off("401-after-relearn");
            return st.phase;
          }
        }
        st.awaitingRelearn = true;
        return st.phase;
      },
      relearnDone() {
        if (st.awaitingRelearn) {
          st.awaitingRelearn = false;
          st.postRelearn = true;
        }
        return st.phase;
      },
      batchOk() {
        st.relearnFails = 0;
        st.postRelearn = false;
        st.awaitingRelearn = false;
        return st.phase;
      },
      miscompare() {
        if (st.phase !== "on") return st.phase;
        st.miscompares += 1;
        if (st.miscompares >= maxMiscompares) off("verify-mismatch");
        return st.phase;
      },
      forceOff(reason) {
        off(reason || "forced");
        return st.phase;
      },
      snapshot() {
        return {
          phase: st.phase,
          reason: st.reason,
          probeFails: st.probeFails,
          relearnFails: st.relearnFails,
          miscompares: st.miscompares,
        };
      },
    };
  }

  return {
    SCRAPE_FIELDS,
    CORE_FIELDS,
    normalizeCompareText,
    parseLooseNumber,
    valuesEqualLoose,
    collectJsonPaths,
    getByPath,
    replaceIdOccurrences,
    buildRequestTemplate,
    applyRequestTemplate,
    filterAuthHeaders,
    latestAuthHeaders,
    learnFromEntries,
    refineMapping,
    extractSnapshotByMapping,
    snapshotsMatch,
    extractedSnapshotLooksSane,
    resolveOpsWarehouse,
    nonEmptySnapshotFields,
    createRequestPacer,
    createApiModeController,
  };
});
