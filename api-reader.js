// Оркестратор чтения одной карточки: probe → on → off с обучением маппинга,
// периодической сверкой и автоматическим фолбэком на страницу. Браузерные
// примитивы (скрейп DOM, снятие трафика, повтор запроса, переучивание токена)
// инъектируются, поэтому модуль тестируется с фейками и не зависит от chrome.*.
(function (root, factory) {
  const api = factory(root.__gaApiMapping || (typeof require === "function" ? require("./api-mapping.js") : null));
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__gaApiReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (M) {
  const DEFAULTS = {
    verifyEveryN: 25, // как часто в режиме on контрольно сверять API с DOM
    maxProbeFails: 2,
    maxRelearnFails: 2,
    maxMiscompares: 2,
    requireOpsField: false, // при активном фильтре складов маппинг обязан знать склад
    opsWarehouses: [], // список опер. складов пользователя для паритета фильтра
  };

  function snapshotFromDomData(data) {
    // DOM-скрейпер возвращает уже готовый снапшот; берём поля как есть.
    const out = {};
    for (const f of M.SCRAPE_FIELDS) {
      out[f] = f === "price" ? Number(data?.[f]) || 0 : String(data?.[f] ?? "");
    }
    return out;
  }

  function createHubApiReader(deps, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const log = typeof deps.log === "function" ? deps.log : function () {};
    const controller = M.createApiModeController({
      maxProbeFails: opts.maxProbeFails,
      maxRelearnFails: opts.maxRelearnFails,
      maxMiscompares: opts.maxMiscompares,
    });

    let template = null;
    let mapping = null;
    let authHeaders = {};
    let onCounter = 0;
    // Промежуточные данные обучения между первым и вторым probe-объектом.
    let probeLearned = null; // { template, fieldCandidates }
    const opsList = Array.isArray(opts.opsWarehouses) ? opts.opsWarehouses : [];

    function haveApiConfig() {
      return Boolean(template && mapping);
    }

    // Приводит сырой API-снапшот к тому виду, что даёт DOM: склад проходит тот же
    // фильтр опер. складов, operationalWarehouseSeen отражает наличие склада.
    function apiDataFromSnapshot(snapshot) {
      const ops = M.resolveOpsWarehouse(snapshot.operationalWarehouse, opsList);
      return Object.assign({}, snapshot, {
        operationalWarehouse: ops.matched,
        operationalWarehouseSeen: ops.seen,
        unsupportedTransitBox: false,
      });
    }

    function absorbAuthFromEntries(entries) {
      const fresh = M.latestAuthHeaders(entries);
      if (Object.keys(fresh).length) {
        authHeaders = fresh;
        return true;
      }
      return false;
    }

    // Единичный API-запрос за объектом item. Возвращает
    // { ok, snapshot?, status, needRelearn?, error? }.
    async function apiReadOne(item) {
      if (!haveApiConfig()) return { ok: false, status: 0, error: "no-config" };
      const req = M.applyRequestTemplate(template, item.articleId);
      if (!req || !req.url) return { ok: false, status: 0, error: "bad-template" };
      let res;
      try {
        res = await deps.replay(req, authHeaders);
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
      const status = Number(res?.status) || 0;
      if (status === 401 || status === 403) {
        return { ok: false, status, needRelearn: true };
      }
      if (status !== 200 || res?.body == null) {
        return { ok: false, status, error: "http-" + status };
      }
      const extracted = M.extractSnapshotByMapping(res.body, mapping);
      if (!extracted.ok || !M.extractedSnapshotLooksSane(extracted.snapshot)) {
        return { ok: false, status, error: "extract-failed" };
      }
      return { ok: true, status, snapshot: extracted.snapshot };
    }

    async function relearnToken(reasonNames) {
      log(
        "HUB API: обновляю токен через страницу" +
          (reasonNames ? " (заголовки: " + reasonNames + ")" : "")
      );
      try {
        await deps.relearnToken();
      } catch (e) {}
      let entries = [];
      try {
        entries = await deps.captureAndClear();
      } catch (e) {}
      absorbAuthFromEntries(entries);
      controller.relearnDone();
    }

    // --- probe: читаем DOM как раньше и параллельно учимся ------------------
    async function probeRead(item) {
      const data = await deps.domScrape(item);
      const snapshot = snapshotFromDomData(data);
      let entries = [];
      try {
        entries = await deps.captureAndClear();
      } catch (e) {}
      absorbAuthFromEntries(entries);

      try {
        if (!probeLearned) {
          const learned = M.learnFromEntries(entries, item.articleId, snapshot);
          if (learned) {
            probeLearned = { template: learned.template, fieldCandidates: learned.fieldCandidates };
          } else {
            controller.probeFail("learn-failed");
          }
        } else {
          // Второй объект: параметризуем шаблон его ID, тянем API и сверяем.
          const req = M.applyRequestTemplate(probeLearned.template, item.articleId);
          const probeAuth = Object.keys(authHeaders).length
            ? authHeaders
            : M.latestAuthHeaders(entries);
          let res = null;
          if (req && req.url) {
            try {
              res = await deps.replay(req, probeAuth);
            } catch (e) {
              res = null;
            }
          }
          const status = Number(res?.status) || 0;
          if (status === 200 && res?.body != null) {
            const refined = M.refineMapping(probeLearned.fieldCandidates, res.body, snapshot);
            if (refined.ok && opts.requireOpsField && !refined.mapping.operationalWarehouse) {
              probeLearned = null;
              controller.probeFail("ops-field-unmapped");
            } else if (refined.ok) {
              template = probeLearned.template;
              mapping = refined.mapping;
              authHeaders = Object.keys(probeAuth).length ? probeAuth : authHeaders;
              controller.probeSuccess();
              log(
                "HUB API: включаю быстрое чтение (заголовки: " +
                  Object.keys(authHeaders).join(", ") +
                  ")"
              );
            } else {
              probeLearned = null;
              controller.probeFail("verify-mismatch:" + refined.mismatches.join(","));
            }
          } else {
            probeLearned = null;
            controller.probeFail("probe-http-" + status);
          }
        }
      } catch (e) {
        controller.probeFail("probe-error");
      }

      if (controller.getPhase() === "off") {
        log("HUB API: остаюсь на чтении через страницу (" + controller.getReason() + ")");
      }
      return { snapshot, path: "dom", data };
    }

    // --- on: только API, с фолбэком и периодической сверкой ----------------
    let domainKnownOk = false; // проверяем домен лениво: тег не уходит с origin сам
    async function ensureOnDomain() {
      if (domainKnownOk || typeof deps.isOnHubDomain !== "function") return;
      let onDomain = true;
      try {
        onDomain = await deps.isOnHubDomain();
      } catch (e) {}
      if (onDomain) domainKnownOk = true;
      else await relearnToken();
    }

    async function apiRead(item) {
      // Первый запрос в режиме on (и после сбоев) проверяет, что вкладка на нужном
      // origin — иначе гарантированный 401. Дальше не дёргаем на каждый объект.
      await ensureOnDomain();

      let attempt = await apiReadOne(item);
      if (!attempt.ok && attempt.needRelearn) {
        domainKnownOk = false;
        controller.batch401();
        if (controller.getPhase() === "off") {
          log("HUB API: отключаю после повторного 401 — дальше страницами.");
          return domReadWithData(item);
        }
        await relearnToken(Object.keys(authHeaders).join(", "));
        domainKnownOk = true;
        attempt = await apiReadOne(item);
      }

      if (!attempt.ok) {
        // Разовый сбой конкретного объекта — читаем его страницей, режим не рушим.
        domainKnownOk = false;
        log("HUB API: объект " + item.articleId + " через страницу (" + (attempt.error || attempt.status) + ")");
        return domReadWithData(item);
      }

      controller.batchOk();
      onCounter += 1;
      // Приводим к DOM-виду (фильтр склада, признак seen) СРАЗУ, чтобы и сверка,
      // и результат работали с одинаковыми значениями.
      const apiData = apiDataFromSnapshot(attempt.snapshot);

      // Периодическая честная сверка: тот же объект и DOM, и API — поля обязаны
      // совпасть, иначе тихо разъезжаемся.
      if (opts.verifyEveryN > 0 && onCounter % opts.verifyEveryN === 0) {
        try {
          const domData = await deps.domScrape(item);
          const domSnap = snapshotFromDomData(domData);
          const cmp = M.snapshotsMatch(apiData, domSnap, M.nonEmptySnapshotFields(domSnap));
          try {
            const entries = await deps.captureAndClear();
            absorbAuthFromEntries(entries);
          } catch (e) {}
          if (!cmp.ok) {
            controller.miscompare();
            log(
              "HUB API: расхождение на сверке (" +
                cmp.mismatches.join(",") +
                ") — беру данные страницы" +
                (controller.getPhase() === "off" ? ", API отключён" : "")
            );
            return { snapshot: domSnap, path: "dom", data: domData };
          }
        } catch (e) {}
      }

      return { snapshot: apiData, path: "api", data: apiData };
    }

    async function domReadWithData(item) {
      const data = await deps.domScrape(item);
      return { snapshot: snapshotFromDomData(data), path: "dom", data };
    }

    async function read(item) {
      const phase = controller.getPhase();
      if (phase === "on") return apiRead(item);
      if (phase === "probe") return probeRead(item);
      return domReadWithData(item);
    }

    return {
      read,
      getPhase: () => controller.getPhase(),
      snapshot: () => ({ phase: controller.getPhase(), reason: controller.getReason(), hasConfig: haveApiConfig() }),
      _controller: controller,
    };
  }

  return { createHubApiReader };
});
