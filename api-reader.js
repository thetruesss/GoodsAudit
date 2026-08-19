// Оркестратор чтения одной карточки returns.o3t.ru.
//
// Логика по объекту:
//   1) узнаём тип отправления (get-article-type);
//   2) неподдерживаемые типы (не posting/exemplar/boxTransit) закрываем сразу —
//      страница на них всё равно показывает «Неподдерживаемый тип»;
//   3) поддерживаемые читаем ручками профиля и приводим к тому же снапшоту,
//      который отдаёт DOM-скрейпер.
//
// У каждого типа своя машина состояний probe → on → off: пока тип не подтвердил
// побайтный паритет с DOM на живых данных, он читается страницей. Сбой одного
// типа не отключает быстрое чтение остальных.
//
// Браузерные примитивы инъектируются, поэтому модуль тестируется с фейками и
// не зависит от chrome.*.
(function (root, factory) {
  const api = factory(
    root.__gaApiMapping || (typeof require === "function" ? require("./api-mapping.js") : null),
    root.__gaApiReturns || (typeof require === "function" ? require("./api-returns.js") : null)
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__gaApiReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (M, RT) {
  const DEFAULTS = {
    verifyEveryN: 25, // как часто в режиме on контрольно сверять API с DOM
    okProbesToEnable: 2, // сколько удачных сверок подряд включают тип
    maxProbeFails: 2,
    maxRelearnFails: 2,
    maxMiscompares: 2,
    opsWarehouses: [], // список опер. складов пользователя для паритета фильтра
  };

  const UNSUPPORTED_CHANNEL = "unsupported";

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
    const opsList = Array.isArray(opts.opsWarehouses) ? opts.opsWarehouses : [];

    // Отдельная машина состояний на каждый «канал» (тип отправления) плюс свой
    // счётчик прочитанного — чтобы редкий тип тоже регулярно сверялся с DOM.
    const channels = new Map();
    const channelCounters = new Map();
    function channelFor(name) {
      const key = String(name || "unknown");
      if (!channels.has(key)) {
        channels.set(
          key,
          M.createApiModeController({
            okProbesToEnable: opts.okProbesToEnable,
            maxProbeFails: opts.maxProbeFails,
            maxRelearnFails: opts.maxRelearnFails,
            maxMiscompares: opts.maxMiscompares,
          })
        );
        channelCounters.set(key, 0);
      }
      return channels.get(key);
    }
    function bumpChannelCounter(name) {
      const key = String(name || "unknown");
      const next = (channelCounters.get(key) || 0) + 1;
      channelCounters.set(key, next);
      return next;
    }
    function channelCounter(name) {
      return channelCounters.get(String(name || "unknown")) || 0;
    }
    // Диагностика: почему по типу не включилось быстрое чтение. Показывается
    // пользователю, поэтому храним и сами расходящиеся значения (усечённо).
    const diagnostics = new Map();
    function noteDiag(name, patch) {
      const key = String(name || "unknown");
      const prev = diagnostics.get(key) || {};
      diagnostics.set(key, Object.assign(prev, patch));
    }
    function shortValue(v) {
      const s = String(v ?? "");
      return s.length > 60 ? s.slice(0, 57) + "…" : s;
    }

    // Ошибка чтения по каналу: на probe это неудачная проба, в режиме on —
    // расхождение доверия. Без этого сломанная ручка никогда не отключалась бы.
    function reportChannelFailure(name, reason) {
      const ctl = channelFor(name);
      const phase = ctl.getPhase();
      if (phase === "probe") ctl.probeFail(reason);
      else if (phase === "on") ctl.miscompare();
      noteDiag(name, { lastError: String(reason || "") });
      if (ctl.getPhase() === "off") {
        log(`API: отключаю тип «${name}» (${ctl.getReason() || reason}) — дальше страницами.`);
      }
      return ctl.getPhase();
    }

    let authHeaders = {};
    let domainKnownOk = false;
    // Тип уже известен по объекту — не тратим лишний запрос при повторном заходе.
    const typeCache = new Map();

    function absorbAuthFromEntries(entries) {
      const fresh = M.latestAuthHeaders(entries);
      if (Object.keys(fresh).length) {
        authHeaders = fresh;
        return true;
      }
      return false;
    }

    async function refreshAuthFromPage() {
      try {
        const entries = await deps.captureAndClear();
        return absorbAuthFromEntries(entries);
      } catch (e) {
        return false;
      }
    }

    // Один запрос к API. Возвращает { ok, body?, status, needRelearn? }.
    async function apiGet(request) {
      if (!request || !request.url) return { ok: false, status: 0, error: "bad-request" };
      let res;
      try {
        res = await deps.replay(request, authHeaders);
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
      const status = Number(res?.status) || 0;
      if (status === 401 || status === 403) return { ok: false, status, needRelearn: true };
      if (status !== 200 || res?.body == null) return { ok: false, status, error: "http-" + status };
      return { ok: true, status, body: res.body };
    }

    async function relearnToken(reasonNames) {
      log(
        "API: обновляю сессию через страницу" +
          (reasonNames ? " (заголовки: " + reasonNames + ")" : "")
      );
      let navigated = false;
      try {
        await deps.relearnToken();
        navigated = true;
      } catch (e) {}
      await refreshAuthFromPage();
      // Домен считаем подтверждённым только если переход действительно удался:
      // иначе вкладка могла остаться где угодно (например, после пересоздания).
      domainKnownOk = navigated;
      for (const ctl of channels.values()) ctl.relearnDone();
    }

    async function ensureOnDomain() {
      if (domainKnownOk || typeof deps.isOnHubDomain !== "function") return;
      let onDomain = true;
      try {
        onDomain = await deps.isOnHubDomain();
      } catch (e) {}
      if (onDomain) domainKnownOk = true;
      else await relearnToken();
    }

    // Достаём тип отправления. null — узнать не удалось.
    async function resolveArticleType(item) {
      const key = String(item.articleId || "").trim();
      if (typeCache.has(key)) return typeCache.get(key);
      const res = await apiGet(RT.resolveTypeRequest(key));
      if (!res.ok) return { failed: true, needRelearn: res.needRelearn === true, status: res.status };
      const body = res.body || {};
      const resolved = {
        articleType: String(body.articleType || "").trim(),
        articleId: String(body.articleId ?? "").trim() || key,
      };
      if (!resolved.articleType) return { failed: true, status: res.status };
      typeCache.set(key, resolved);
      return resolved;
    }

    // Дочитывание деталей по уже известному типу → сырой снапшот (как у DOM).
    async function apiReadDetails(articleType, articleId) {
      if (!RT.isSupportedType(articleType)) {
        // Страница таким типам показывает «Неподдерживаемый тип» — повторяем.
        return {
          ok: true,
          channel: UNSUPPORTED_CHANNEL,
          articleType,
          snapshot: RT.mapUnsupported(articleId),
        };
      }

      const infoRes = await apiGet(RT.infoRequest(articleType, articleId));
      if (!infoRes.ok) {
        return { ok: false, needRelearn: infoRes.needRelearn === true, channel: articleType, error: infoRes.error || ("http-" + infoRes.status) };
      }
      // Неизвестный нам код статуса/схемы означает, что на странице будет
      // подпись, которой у нас нет — такой объект честнее дочитать страницей.
      if (RT.snapshotHasUnknownCodes(articleType, infoRes.body)) {
        return { ok: false, channel: articleType, error: "unknown-code" };
      }

      let content = null;
      const contentReq = RT.contentRequest(articleType, articleId);
      if (contentReq) {
        const contentRes = await apiGet(contentReq);
        if (!contentRes.ok) {
          return {
            ok: false,
            needRelearn: contentRes.needRelearn === true,
            channel: articleType,
            error: contentRes.error || ("http-" + contentRes.status),
          };
        }
        content = contentRes.body;
      }

      const snapshot = RT.mapByType(articleType, infoRes.body, content);
      if (!snapshot) return { ok: false, channel: articleType, error: "map-failed" };
      return { ok: true, channel: articleType, articleType, snapshot };
    }

    // Приводит сырой снапшот к виду DOM: склад проходит тот же фильтр опер.
    // складов, operationalWarehouseSeen отражает наличие склада на карточке,
    // затем применяется та же нормализация, что и к данным со страницы.
    function toDomShape(snapshot, item) {
      const ops = M.resolveOpsWarehouse(snapshot.operationalWarehouse, opsList);
      const withOps = Object.assign({}, snapshot, {
        operationalWarehouse: ops.matched,
        operationalWarehouseSeen: ops.seen,
      });
      if (typeof deps.normalize !== "function") return withOps;
      return deps.normalize(withOps, item);
    }

    async function domRead(item) {
      const data = await deps.domScrape(item);
      return { snapshot: snapshotFromDomData(data), path: "dom", data };
    }

    // Сравнение API и DOM по непустым полям DOM-эталона. Для неподдерживаемых
    // типов сверяем сам факт «неподдерживаемый».
    function compareWithDom(apiData, domData, channel) {
      if (channel === UNSUPPORTED_CHANNEL) {
        const domUnsupported = Boolean(domData?.unsupportedTransitBox);
        return {
          ok: domUnsupported === true,
          mismatches: domUnsupported ? [] : ["unsupportedTransitBox"],
        };
      }
      const domSnap = snapshotFromDomData(domData);
      return M.snapshotsMatch(apiData, domSnap, M.nonEmptySnapshotFields(domSnap));
    }

    async function read(item) {
      // Разрешение типа перестало работать (нет прав/ручка закрыта) — дальше
      // только страницы, лишних запросов не делаем.
      const resolveCtl = channelFor("resolve");
      if (resolveCtl.getPhase() === "off") return domRead(item);

      await ensureOnDomain();

      // Шаг 1 — тип отправления (один лёгкий запрос).
      let resolved = await resolveArticleType(item);
      if (resolved?.failed && resolved.needRelearn) {
        domainKnownOk = false;
        resolveCtl.batch401();
        if (resolveCtl.getPhase() !== "off") {
          await relearnToken(Object.keys(authHeaders).join(", "));
          resolved = await resolveArticleType(item);
        }
      }
      if (!resolved || resolved.failed) {
        reportChannelFailure("resolve", "resolve-failed");
        if (resolveCtl.getPhase() === "off") {
          log("API: не удалось определить тип отправления — дальше читаю страницами.");
        }
        return domRead(item);
      }
      resolveCtl.probeSuccess();
      resolveCtl.batchOk();

      // Шаг 2 — канал этого типа. У каждого неподдерживаемого типа свой канал:
      // подтверждённый «pallet» не должен молча закрывать какой-нибудь другой тип.
      const channel = RT.isSupportedType(resolved.articleType)
        ? resolved.articleType
        : `${UNSUPPORTED_CHANNEL}:${resolved.articleType || "unknown"}`;
      const ctl = channelFor(channel);
      if (ctl.getPhase() === "off") return domRead(item);

      let attempt = await apiReadDetails(resolved.articleType, resolved.articleId);
      if (!attempt.ok && attempt.needRelearn) {
        domainKnownOk = false;
        ctl.batch401();
        if (ctl.getPhase() !== "off") {
          await relearnToken(Object.keys(authHeaders).join(", "));
          attempt = await apiReadDetails(resolved.articleType, resolved.articleId);
        }
      }

      if (!attempt.ok) {
        // «Неизвестный код» — свойство конкретного объекта, а не поломка канала:
        // такой объект просто дочитываем страницей. Остальные сбои копятся и
        // в итоге отключают тип.
        if (attempt.error !== "unknown-code") {
          reportChannelFailure(channel, attempt.error || "read-failed");
        }
        return domRead(item);
      }

      const phase = ctl.getPhase();
      const apiData = toDomShape(attempt.snapshot, item);

      // Канал ещё не подтверждён либо пришло время контрольной сверки —
      // читаем то же самое страницей и сравниваем поле в поле.
      const seenInChannel = channelCounter(channel);
      const needVerify =
        phase === "probe" ||
        (opts.verifyEveryN > 0 && seenInChannel > 0 && seenInChannel % opts.verifyEveryN === 0);

      if (needVerify) {
        const domData = await deps.domScrape(item);
        await refreshAuthFromPage();
        const cmp = compareWithDom(apiData, domData, channel);
        if (cmp.ok) {
          if (phase === "probe") {
            const next = ctl.probeSuccess();
            if (next === "on") {
              log(
                `API: включаю быстрое чтение для типа «${channel}» ` +
                  `(заголовки: ${Object.keys(authHeaders).join(", ") || "нет"})`
              );
            }
          } else {
            ctl.batchOk();
          }
        } else {
          if (phase === "probe") {
            ctl.probeFail("verify:" + cmp.mismatches.join(","));
          } else {
            ctl.miscompare();
          }
          // Запоминаем сами расходящиеся значения — по ним сразу видно,
          // где маппинг разошёлся с вёрсткой.
          const domSnap = snapshotFromDomData(domData);
          const samples = cmp.mismatches.slice(0, 4).map((field) => ({
            field,
            api: shortValue(apiData?.[field]),
            dom: shortValue(domSnap?.[field]),
          }));
          noteDiag(channel, { mismatches: cmp.mismatches.slice(0, 8), samples });
          log(
            `API: расхождение со страницей по типу «${channel}» ` +
              `(${cmp.mismatches.join(",")}) — беру данные страницы` +
              (ctl.getPhase() === "off" ? ", тип отключён" : "")
          );
        }
        // На сверке источником истины всегда остаётся страница.
        bumpChannelCounter(channel);
        return { snapshot: snapshotFromDomData(domData), path: "dom", data: domData };
      }

      ctl.batchOk();
      bumpChannelCounter(channel);
      return { snapshot: apiData, path: "api", data: apiData, articleType: attempt.articleType };
    }

    return {
      read,
      getPhase: (channel) => channelFor(channel || "posting").getPhase(),
      snapshot: () => {
        const out = {};
        for (const [name, ctl] of channels.entries()) {
          out[name] = Object.assign(ctl.snapshot(), diagnostics.get(name) || {});
        }
        return out;
      },
    };
  }

  return { createHubApiReader };
});
