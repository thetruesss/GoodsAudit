// Перехватчик сетевого трафика страницы (MAIN world, document_start).
// Патчит fetch и XMLHttpRequest, чтобы снять заголовки авторизации, которые
// страница выставляет сама. Ничего никуда не отправляет — только пишет в
// небольшой оконный буфер, который фон читает через executeScript.
// В HAR Authorization/Cookie вырезаются, поэтому снять их можно лишь живьём.
(function () {
  if (window.__gaCaptureInstalled) return;
  window.__gaCaptureInstalled = true;

  // Нужны только заголовки авторизации и адреса — тела ответов не храним:
  // буфер целиком копируется в фон, и лишние мегабайты там ни к чему.
  var MAX_ENTRIES = 20;
  var buffer = [];
  window.__gaCapturedRequests = buffer;

  function pushEntry(entry) {
    try {
      buffer.push(entry);
      if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    } catch (e) {}
  }

  // Отсекаем статику — интересуют только запросы к бэкенду (обычно API/данные).
  function looksLikeApiUrl(url) {
    var u = String(url || "");
    if (!u) return false;
    if (/^data:|^blob:/i.test(u)) return false;
    if (/\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(?:\?|#|$)/i.test(u)) {
      return false;
    }
    return true;
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      // Относительные пути — тот же origin.
      return !/^https?:\/\//i.test(String(url || ""));
    }
  }

  function headersToObject(headers) {
    var out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === "function" && typeof headers.get === "function") {
        headers.forEach(function (value, key) {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
      if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (Array.isArray(pair) && pair.length >= 2) {
            out[String(pair[0]).toLowerCase()] = String(pair[1]);
          }
        });
        return out;
      }
      if (typeof headers === "object") {
        Object.keys(headers).forEach(function (key) {
          out[String(key).toLowerCase()] = String(headers[key]);
        });
      }
    } catch (e) {}
    return out;
  }

  // Только заголовки, похожие на авторизационные: токены в буфере не нужны
  // целиком, а всё остальное — лишний вес.
  var AUTH_PREFIXES = ["x-o3-", "x-csrf", "x-xsrf", "x-auth"];
  function keepAuthHeaders(headers) {
    var out = {};
    try {
      Object.keys(headers || {}).forEach(function (name) {
        var low = String(name).toLowerCase();
        var isAuth =
          low === "authorization" ||
          AUTH_PREFIXES.some(function (p) {
            return low.indexOf(p) === 0;
          });
        if (isAuth) out[low] = String(headers[name]);
      });
    } catch (e) {}
    return out;
  }

  // --- fetch ---------------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url;
      var method;
      var reqHeaders = {};
      try {
        if (input && typeof input === "object" && "url" in input) {
          url = input.url;
          method = String(input.method || (init && init.method) || "GET");
          reqHeaders = headersToObject(input.headers);
        } else {
          url = String(input);
          method = String((init && init.method) || "GET");
        }
        if (init && init.headers) {
          var extra = headersToObject(init.headers);
          Object.keys(extra).forEach(function (k) {
            reqHeaders[k] = extra[k];
          });
        }
      } catch (e) {}

      var promise = origFetch.apply(this, arguments);
      try {
        var auth = keepAuthHeaders(reqHeaders);
        if (url && sameOrigin(url) && looksLikeApiUrl(url) && Object.keys(auth).length) {
          pushEntry({
            url: String(url),
            method: String(method || "GET").toUpperCase(),
            headers: auth,
            at: Date.now(),
          });
        }
      } catch (e) {}
      return promise;
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSetHeader = XHR.prototype.setRequestHeader;

      XHR.prototype.open = function (method, url) {
        try {
          this.__gaCap = { method: String(method || "GET"), url: String(url || ""), headers: {} };
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__gaCap) this.__gaCap.headers[String(name).toLowerCase()] = String(value);
        } catch (e) {}
        return origSetHeader.apply(this, arguments);
      };

      XHR.prototype.send = function (body) {
        try {
          var cap = this.__gaCap;
          if (cap && sameOrigin(cap.url) && looksLikeApiUrl(cap.url)) {
            var auth = keepAuthHeaders(cap.headers);
            if (Object.keys(auth).length) {
              pushEntry({
                url: cap.url,
                method: String(cap.method || "GET").toUpperCase(),
                headers: auth,
                at: Date.now(),
              });
            }
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
