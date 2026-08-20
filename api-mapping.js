// Общие (не привязанные к конкретному API) кирпичики быстрого чтения:
// разбор перехваченных заголовков авторизации, сравнение снапшотов на паритет
// с DOM, паритет фильтра опер. складов, ограничитель нагрузки и машина
// состояний probe → on → off. Без ввода-вывода и chrome.* — работает и в
// service worker (importScripts), и в Node (require) для тестов.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__gaApiMapping = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
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

  // Свежие авторизационные заголовки из перехваченного трафика (новые в конце).
  function latestAuthHeaders(entries) {
    const list = Array.isArray(entries) ? entries : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const auth = filterAuthHeaders(list[i]?.headers);
      if (Object.keys(auth).length) return auth;
    }
    return {};
  }

  function nonEmptySnapshotFields(snapshot) {
    const out = [];
    for (const field of SCRAPE_FIELDS) {
      const v = snapshot?.[field];
      if (field === "price") {
        // Number(null) и Number("") конечны — иначе страница без суммы
        // считалась бы эталоном с ценой 0 и давала ложное расхождение.
        if (v != null && v !== "" && Number.isFinite(Number(v))) out.push(field);
        continue;
      }
      if (normalizeCompareText(v)) out.push(field);
    }
    return out;
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

  // Пул вкладок: выдаёт свободную, ставит в очередь, если все заняты. Нужен,
  // потому что чтение через API вкладку не занимает (навигации там нет), а
  // чтение страницей занимает — и вкладок под страницы держим мало.
  function createTabPool(initialIds) {
    const ids = Array.isArray(initialIds) ? initialIds.slice() : [];
    const free = ids.slice();
    const waiters = [];
    const pool = {
      size: () => ids.length,
      free: () => free.length,
      waiting: () => waiters.length,
      all: () => ids.slice(),
      acquire() {
        const id = free.shift();
        if (id != null) return Promise.resolve(id);
        return new Promise((resolve) => waiters.push(resolve));
      },
      release(id) {
        if (id == null || !ids.includes(id)) return;
        if (free.includes(id)) return;
        const waiter = waiters.shift();
        if (waiter) waiter(id);
        else free.push(id);
      },
      add(id) {
        if (id == null || ids.includes(id)) return;
        ids.push(id);
        pool.release(id);
      },
      // Зависшую вкладку меняем на свежую, не ломая очередь ожидающих.
      replace(oldId, newId) {
        const i = ids.indexOf(oldId);
        if (i >= 0) ids[i] = newId;
        const f = free.indexOf(oldId);
        if (f >= 0) free.splice(f, 1);
      },
    };
    return pool;
  }

  // Машина состояний одного «канала» чтения: probe → on → off. Заводится
  // отдельно на каждый тип отправления, чтобы сбой одного типа не отключал
  // быстрое чтение остальных.
  function createApiModeController(opts = {}) {
    const okProbesToEnable = Math.max(1, Number(opts.okProbesToEnable) || 2);
    const maxProbeFails = Math.max(1, Number(opts.maxProbeFails) || 2);
    const maxRelearnFails = Math.max(1, Number(opts.maxRelearnFails) || 2);
    const maxMiscompares = Math.max(1, Number(opts.maxMiscompares) || 2);
    const st = {
      phase: "probe",
      reason: "",
      okProbes: 0,
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
        st.okProbes = 0;
        if (st.probeFails >= maxProbeFails) off(reason || "probe-failed");
        return st.phase;
      },
      // Успешная сверка на probe: включаемся только после нескольких подряд.
      probeSuccess() {
        if (st.phase !== "probe") return st.phase;
        st.okProbes += 1;
        if (st.okProbes >= okProbesToEnable) st.phase = "on";
        return st.phase;
      },
      batch401() {
        // Считаем 401 и на probe: иначе постоянный отказ авторизации крутил бы
        // переучивание на каждом объекте бесконечно.
        if (st.phase === "off") return st.phase;
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
          okProbes: st.okProbes,
          probeFails: st.probeFails,
          relearnFails: st.relearnFails,
          miscompares: st.miscompares,
        };
      },
    };
  }

  return {
    SCRAPE_FIELDS,
    normalizeCompareText,
    parseLooseNumber,
    valuesEqualLoose,
    filterAuthHeaders,
    latestAuthHeaders,
    nonEmptySnapshotFields,
    snapshotsMatch,
    resolveOpsWarehouse,
    createRequestPacer,
    createTabPool,
    createApiModeController,
  };
});
