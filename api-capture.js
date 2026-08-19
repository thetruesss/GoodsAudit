// Перехватчик сетевого трафика страницы (MAIN world, document_start).
// Патчит fetch и XMLHttpRequest, чтобы снять реальные запросы страницы вместе
// с их заголовками авторизации и телами ответов. Ничего никуда не отправляет —
// только пишет в оконный буфер, который фон читает через executeScript.
// Заголовки Authorization в HAR вырезаются (см. ТЗ), поэтому снимаем их живьём.
(function () {
  if (window.__gaCaptureInstalled) return;
  window.__gaCaptureInstalled = true;

  var MAX_ENTRIES = 80;
  var MAX_BODY_CHARS = 2_000_000;
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

  function bodyToString(body) {
    try {
      if (body == null) return null;
      if (typeof body === "string") return body.length <= MAX_BODY_CHARS ? body : null;
    } catch (e) {}
    return null;
  }

  // --- fetch ---------------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url;
      var method;
      var reqHeaders = {};
      var reqBody = null;
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
        if (init && init.body != null) reqBody = bodyToString(init.body);
      } catch (e) {}

      var promise = origFetch.apply(this, arguments);
      try {
        if (url && sameOrigin(url) && looksLikeApiUrl(url)) {
          promise
            .then(function (resp) {
              try {
                var clone = resp.clone();
                clone
                  .text()
                  .then(function (text) {
                    pushEntry({
                      url: String(url),
                      method: String(method || "GET").toUpperCase(),
                      headers: reqHeaders,
                      body: reqBody,
                      status: resp.status,
                      responseText: text && text.length <= MAX_BODY_CHARS ? text : "",
                      at: Date.now(),
                    });
                  })
                  .catch(function () {});
              } catch (e) {}
              return resp;
            })
            .catch(function () {});
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
            cap.body = bodyToString(body);
            var xhr = this;
            this.addEventListener("load", function () {
              try {
                var text = "";
                try {
                  text = xhr.responseType === "" || xhr.responseType === "text"
                    ? String(xhr.responseText || "")
                    : "";
                } catch (e) {}
                pushEntry({
                  url: cap.url,
                  method: String(cap.method || "GET").toUpperCase(),
                  headers: cap.headers,
                  body: cap.body,
                  status: xhr.status,
                  responseText: text && text.length <= MAX_BODY_CHARS ? text : "",
                  at: Date.now(),
                });
              } catch (e) {}
            });
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
