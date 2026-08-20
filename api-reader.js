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
    verifyEveryN: 25, // первый шаг контрольной сверки API с DOM в режиме on
    // Дальше шаг растёт вдвое до этого потолка. Сверка — полная загрузка
    // страницы, и на тысячах объектов «каждый 25-й» съедает весь выигрыш,
    // хотя сотня совпадений подряд уже сказала всё, что могла.
    maxVerifyEveryN: 200,
    // Сколько ждать чужую пробу, прежде чем делать свою (мс).
    probeWaitMs: 30000,
    // Одной сверки достаточно: совпасть должны все непустые поля карточки
    // (цена, номенклатура, номер, id, склад, три статуса, схема) — случайно
    // такое не совпадает. Каждая лишняя проба стоит полной загрузки страницы.
    okProbesToEnable: 1,
    maxProbeFails: 2,
    maxRelearnFails: 2,
    maxMiscompares: 2,
    maxRateLimitRetries: 3, // сколько раз переждать 429/503 по одному запросу
    opsWarehouses: [], // список опер. складов пользователя для паритета фильтра
  };

  const UNSUPPORTED_CHANNEL = "unsupported";

  // Ответы, на которых нужно подождать и повторить, а не считать ручку сломанной.
  const RATE_LIMIT_STATUSES = new Set([429, 503]);
  const RATE_LIMIT_BACKOFF_MS = 500;

  // Номера прочитанного, на которых делаем контрольную сверку: base, потом шаг
  // удваивается до потолка (25, 75, 175, 375, 775, 1575, дальше каждые cap).
  // Функция чистая — считает по общему на все потоки номеру объекта, поэтому
  // своего состояния не держит и на потоки делиться не может.
  function isAuditIndex(seen, base, cap) {
    const first = Number(base) || 0;
    if (!(first > 0) || !(seen > 0)) return false; // 0 — периодическая сверка выключена
    const top = Math.max(first, Number(cap) || first);
    let at = first;
    let step = first;
    while (at < seen && step < top) {
      step = Math.min(step * 2, top);
      at += step;
    }
    if (at >= seen) return at === seen;
    return (seen - at) % top === 0;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  // Ожидание, которое можно снять. Нужно в гонке с чужой пробой: без отмены
  // таймер продолжает тикать все свои полминуты, даже когда ждать уже нечего.
  function cancellableDelay(ms) {
    let id = null;
    const promise = new Promise((resolve) => {
      id = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
    return { promise, cancel: () => clearTimeout(id) };
  }

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
    // Состояние общее на все потоки (передаётся снаружи): иначе каждое окно
    // пробовало бы типы заново и вело свою статистику. Токены при этом у
    // каждого потока свои — их общими делать нельзя.
    const channels = opts.sharedChannels instanceof Map ? opts.sharedChannels : new Map();
    const channelCounters =
      opts.sharedCounters instanceof Map ? opts.sharedCounters : new Map();
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
    // Проба стоит полной загрузки страницы, поэтому по каналу она должна быть
    // одна: потоки, зашедшие в тот же момент, ждут её результата, а не
    // повторяют её каждый у себя. Иначе в начале прогона страниц открывается
    // ровно столько, сколько потоков, — и весь выигрыш съедается на старте.
    const probeLocks = opts.sharedProbeLocks instanceof Map ? opts.sharedProbeLocks : new Map();
    async function waitForRunningProbe(name) {
      const inFlight = probeLocks.get(String(name || "unknown"));
      if (!inFlight) return;
      // Ждём не бесконечно: если чужая проба зависла, читаем сами.
      const timer = cancellableDelay(opts.probeWaitMs);
      try {
        await Promise.race([inFlight, timer.promise]);
      } finally {
        timer.cancel();
      }
    }
    function startProbeLock(name) {
      const key = String(name || "unknown");
      let release = function () {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      probeLocks.set(key, gate);
      return function () {
        if (probeLocks.get(key) === gate) probeLocks.delete(key);
        release();
      };
    }
    // Диагностика: почему по типу не включилось быстрое чтение. Показывается
    // пользователю, поэтому храним и сами расходящиеся значения (усечённо).
    const diagnostics = opts.sharedDiagnostics instanceof Map ? opts.sharedDiagnostics : new Map();
    function noteDiag(name, patch) {
      const key = String(name || "unknown");
      const prev = diagnostics.get(key) || {};
      diagnostics.set(key, Object.assign(prev, patch));
    }
    function shortValue(v) {
      const s = String(v ?? "");
      return s.length > 60 ? s.slice(0, 57) + "…" : s;
    }

    // Сквозной учёт: каждый уход на страницу считается с причиной, чтобы не
    // осталось ни одного молчаливого фолбэка.
    const fallbackReasons =
      opts.sharedFallbacks instanceof Map ? opts.sharedFallbacks : new Map();
    function countFallback(reason) {
      const key = String(reason || "без причины");
      fallbackReasons.set(key, (fallbackReasons.get(key) || 0) + 1);
    }
    async function fallbackToDom(item, reason) {
      countFallback(reason);
      return domRead(item);
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
    const typeCache = opts.sharedTypeCache instanceof Map ? opts.sharedTypeCache : new Map();

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
    async function apiGet(request, attempt = 0) {
      if (!request || !request.url) return { ok: false, status: 0, error: "bad-request" };
      let res;
      try {
        res = await deps.replay(request, authHeaders);
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
      const status = Number(res?.status) || 0;
      if (status === 401 || status === 403) return { ok: false, status, needRelearn: true };
      // 429 и 503 — не поломка ручки, а просьба притормозить. Ограничитель уже
      // сбросил скорость вдвое; нам остаётся подождать и повторить. Считать это
      // сбоем канала нельзя: один всплеск нагрузки выключил бы быстрое чтение
      // целиком, и весь прогон ушёл бы на страницы.
      if (RATE_LIMIT_STATUSES.has(status) && attempt < opts.maxRateLimitRetries) {
        const hinted = Number(res?.retryAfterMs) || 0;
        await delay(Math.max(hinted, RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt)));
        return apiGet(request, attempt + 1);
      }
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

      // Карточку и её состав тянем одновременно — это экономит целый круг
      // запросов на каждом объекте.
      const contentReq = RT.contentRequest(articleType, articleId);
      const [infoRes, contentResRaw] = await Promise.all([
        apiGet(RT.infoRequest(articleType, articleId)),
        contentReq ? apiGet(contentReq) : Promise.resolve(null),
      ]);
      if (!infoRes.ok) {
        return { ok: false, needRelearn: infoRes.needRelearn === true, channel: articleType, error: infoRes.error || ("http-" + infoRes.status) };
      }
      // Ручка может сама ответить, что объект профилю не по зубам. Страница на
      // таком рисует информер «Неподдерживаемый тип» — отвечаем тем же, иначе
      // получалась пустая карточка без склада, и объект уходил в ошибки.
      if (RT.payloadSaysUnsupported(articleType, infoRes.body)) {
        return {
          ok: true,
          channel: articleType,
          articleType,
          snapshot: RT.mapUnsupported(articleId),
        };
      }
      // Неизвестный нам код статуса/схемы означает, что на странице будет
      // подпись, которой у нас нет — такой объект честнее дочитать страницей,
      // заодно подсмотрев на ней перевод кода.
      const unknownCodes = RT.unknownCodesInInfo(articleType, infoRes.body);
      if (unknownCodes.length) {
        return {
          ok: false,
          channel: articleType,
          error: "unknown-code",
          unknownCodes,
          info: infoRes.body,
          articleType,
        };
      }

      let content = null;
      if (contentReq) {
        const contentRes = contentResRaw || { ok: false, status: 0 };
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
    function toDomShape(snapshot, item, opsOverride) {
      const ops = opsOverride || M.resolveOpsWarehouse(snapshot.operationalWarehouse, opsList);
      const withOps = Object.assign({}, snapshot, {
        operationalWarehouse: ops.matched,
        operationalWarehouseSeen: ops.seen,
      });
      if (typeof deps.normalize !== "function") return withOps;
      return deps.normalize(withOps, item);
    }

    // Когда фильтр складов задан, а текущее место — не наше, DOM-скрейпер идёт
    // искать наш склад в блоке «Последняя перевозка». Повторяем это тем же
    // запросом — иначе объекты «в пути» вечно расходились бы со страницей.
    async function resolveOpsWithCarriage(articleType, articleId, snapshot) {
      const ops = M.resolveOpsWarehouse(snapshot.operationalWarehouse, opsList);
      if (ops.matched || !opsList.length) return ops;
      const req = RT.lastCarriageRequest(articleType, articleId);
      if (!req) return ops;
      const res = await apiGet(req);
      if (!res.ok) return ops;
      for (const place of RT.carriagePlaceNames(res.body)) {
        const hit = M.resolveOpsWarehouse(place, opsList);
        if (hit.matched) return { matched: hit.matched, seen: true };
      }
      return ops;
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
      if (resolveCtl.getPhase() === "off") {
        return fallbackToDom(item, "определение типа отключено");
      }

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
        const why = resolved?.status ? `http-${resolved.status}` : "нет ответа";
        reportChannelFailure("resolve", `определение типа: ${why}`);
        if (resolveCtl.getPhase() === "off") {
          log("API: не удалось определить тип отправления — дальше читаю страницами.");
        }
        return fallbackToDom(item, `определение типа: ${why}`);
      }
      resolveCtl.probeSuccess();
      resolveCtl.batchOk();

      // Шаг 2 — канал этого типа. Все неподдерживаемые типы идут одним каналом:
      // страница показывает «Неподдерживаемый тип» вообще всему, что вне трёх
      // типов профиля, поэтому механизм один и проверять его на каждый тип
      // отдельно — только лишние загрузки страниц. Периодическая сверка на этом
      // канале остаётся: если приложение научится показывать что-то ещё, она это
      // поймает.
      const channel = RT.isSupportedType(resolved.articleType)
        ? resolved.articleType
        : UNSUPPORTED_CHANNEL;
      const ctl = channelFor(channel);
      if (ctl.getPhase() === "off") {
        return fallbackToDom(item, `тип «${channel}» отключён`);
      }

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
        // читаем его страницей и заодно узнаём перевод кода, чтобы следующие
        // такие объекты уже шли через API.
        if (attempt.error === "unknown-code") {
          const codes = (attempt.unknownCodes || []).join(", ");
          countFallback(`неизвестный код: ${codes}`);
          const domRes = await domRead(item);
          const learned = RT.learnLabelsFromDom(attempt.articleType, attempt.info, domRes.data);
          noteDiag(channel, {
            lastError: `неизвестный код: ${codes}`,
            learned: learned.length ? learned : undefined,
          });
          if (learned.length) log(`API: выучил подписи со страницы — ${learned.join("; ")}`);
          return domRes;
        }
        const why = attempt.error || "read-failed";
        reportChannelFailure(channel, why);
        return fallbackToDom(item, `чтение деталей: ${why}`);
      }

      // Пока канал не подтверждён, пробу делает кто-то один — остальные ждут
      // её исхода и идут уже по готовому решению.
      let phase = ctl.getPhase();
      let releaseProbe = null;
      if (phase === "probe") {
        // Чужая проба уже идёт — ждём её исход вместо своей такой же. Ждём
        // ограниченное число раз: если проба зависла, пробуем сами, а не стоим.
        for (let waits = 0; waits < 2 && phase === "probe" && probeLocks.has(channel); waits++) {
          await waitForRunningProbe(channel);
          phase = ctl.getPhase();
        }
        if (phase === "off") {
          return fallbackToDom(item, `тип «${channel}» отключён`);
        }
        // Проверка слота и его захват идут подряд, без await между ними, иначе
        // два потока успеют оба решить, что пробу делают они.
        if (phase === "probe") releaseProbe = startProbeLock(channel);
      }

      try {
        const opsResolved = await resolveOpsWithCarriage(
          resolved.articleType,
          resolved.articleId,
          attempt.snapshot
        );
        const apiData = toDomShape(attempt.snapshot, item, opsResolved);

        // Номер объекта в канале берём сразу с увеличением счётчика: если
        // сначала прочитать, а увеличить потом, то все потоки, вошедшие на
        // одном и том же номере, назначат сверку каждый себе — вместо одной
        // страницы открывается столько, сколько потоков.
        const seenInChannel = bumpChannelCounter(channel);
        const needVerify =
          phase === "probe" ||
          isAuditIndex(seenInChannel, opts.verifyEveryN, opts.maxVerifyEveryN);

        if (needVerify) return await verifyAgainstDom(item, channel, phase, apiData);

        ctl.batchOk();
        return { snapshot: apiData, path: "api", data: apiData, articleType: attempt.articleType };
      } finally {
        if (releaseProbe) releaseProbe();
      }
    }

    // Читает тот же объект страницей и сравнивает поле в поле. На сверке
    // источником истины всегда остаётся страница.
    async function verifyAgainstDom(item, channel, phase, apiData) {
      const ctl = channelFor(channel);
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
      countFallback(cmp.ok ? "контрольная сверка со страницей" : "расхождение со страницей");
      return { snapshot: snapshotFromDomData(domData), path: "dom", data: domData };
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
      // Сводка «почему читали страницей»: самые частые причины за прогон.
      fallbackSummary: () =>
        [...fallbackReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([reason, count]) => ({ reason, count })),
    };
  }

  return { createHubApiReader };
});
