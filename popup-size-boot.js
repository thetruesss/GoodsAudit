(function () {
  try {
    var raw = localStorage.getItem("goodsAuditPopupSizeV1");
    if (!raw) return;
    var size = JSON.parse(raw);
    var w = Math.min(800, Math.max(360, Math.round(Number(size && size.w) || 0)));
    var h = Math.min(600, Math.max(380, Math.round(Number(size && size.h) || 0)));
    if (!w || !h) return;
    var root = document.documentElement;
    root.style.setProperty("--popup-w", w + "px");
    root.style.setProperty("--popup-h", h + "px");
    root.style.width = w + "px";
    root.style.height = h + "px";
  } catch (e) {}
})();
