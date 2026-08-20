// Тесты поведения настроек в настоящем браузере: сворачивающийся раздел,
// перетаскивание тумблеров и взаимное исключение быстрого чтения с
// агрессивным режимом. Проверять это фейковым DOM бессмысленно — тут всё
// держится на реальных событиях указателя и CSS-переходах.
//
// Нужен playwright и Chromium: `node tests/browser/test-popup-toggles.js`.
// Без них тест пропускается — основной раннер остаётся без зависимостей.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

// chrome.* в попапе нужен только чтобы он вообще стартовал.
const CHROME_STUB = `
(() => {
  const store = {};
  const norm = (k) => k == null ? Object.keys(store) : (typeof k === "string" ? [k] : (Array.isArray(k) ? k : Object.keys(k)));
  window.chrome = {
    runtime: {
      id: "test",
      getURL: (p) => "/" + String(p || "").replace(/^\\/+/, ""),
      sendMessage: (m, cb) => {
        const r = { ok: true, job: null };
        if (cb) { setTimeout(() => cb(r), 0); return; }
        return Promise.resolve(r);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (k) => { const o = {}; for (const key of norm(k)) if (key in store) o[key] = store[key]; return o; },
        set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
        remove: async (k) => { for (const key of norm(k)) delete store[key]; },
        clear: async () => { for (const key of Object.keys(store)) delete store[key]; },
      },
      onChanged: { addListener: () => {} },
    },
  };
})();`;

const cases = [];
const check = (name, ok, extra = "") => cases.push({ name, ok, extra });

const switchOf = (page, id) => page.locator(`#${id}`).locator("xpath=..");
const checkedOf = (page, id) => page.evaluate((x) => document.querySelector("#" + x).checked, id);

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.log("playwright не установлен — тест пропущен");
    return 0;
  }

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "popup.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("no"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}
  );
  const page = await browser.newPage({ viewport: { width: 480, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(CHROME_STUB);
  await page.goto(`http://127.0.0.1:${port}/popup.html`);
  await page.waitForTimeout(700);
  await page.click("#btnOpenSettings");
  await page.waitForTimeout(350);

  // --- сворачивающийся раздел ---
  const bodyHeight = () =>
    page.evaluate(() => document.querySelector("#behaviorGroupBody").getBoundingClientRect().height);

  check(
    "«Поведение и вид» изначально свёрнут",
    (await bodyHeight()) < 4 && (await page.getAttribute("#behaviorGroupToggle", "aria-expanded")) === "false"
  );

  await page.locator("#behaviorGroupToggle").scrollIntoViewIfNeeded();
  await page.click("#behaviorGroupToggle");
  await page.waitForTimeout(90);
  const midway = await bodyHeight();
  await page.waitForTimeout(500);
  const opened = await bodyHeight();
  check(
    "раскрывается плавно, а не рывком",
    midway > 4 && midway < opened - 20,
    `в середине ${Math.round(midway)}, в конце ${Math.round(opened)}`
  );
  check(
    "открытый раздел не обрезает подсказки",
    await page.evaluate(
      () => getComputedStyle(document.querySelector(".settings-group-body-inner")).overflow === "visible"
    )
  );

  // --- взаимное исключение ---
  await page.evaluate(() => {
    document.querySelector("#apiReadToggle").checked = false;
    document.querySelector("#aggressiveModeToggle").checked = false;
  });
  await switchOf(page, "apiReadToggle").click();
  await page.waitForTimeout(120);
  await switchOf(page, "aggressiveModeToggle").click();
  await page.waitForTimeout(180);
  check(
    "включили агрессивный режим — быстрое чтение выключилось",
    (await checkedOf(page, "aggressiveModeToggle")) === true &&
      (await checkedOf(page, "apiReadToggle")) === false
  );
  await switchOf(page, "apiReadToggle").click();
  await page.waitForTimeout(180);
  check(
    "включили быстрое чтение — агрессивный режим выключился",
    (await checkedOf(page, "apiReadToggle")) === true &&
      (await checkedOf(page, "aggressiveModeToggle")) === false
  );

  // --- перетаскивание ---
  const box = await switchOf(page, "uiGradientToggle").boundingBox();
  const before = await checkedOf(page, "uiGradientToggle");
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.75, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, midY, { steps: 6 });
  const knobMidway = await page.evaluate(() =>
    getComputedStyle(
      document.querySelector("#uiGradientToggle").parentElement.querySelector(".ui-switch-track")
    )
      .getPropertyValue("--knob-x")
      .trim()
  );
  await page.mouse.move(box.x + box.width * 0.1, midY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check(
    "ползунок идёт за курсором, а не прыгает по краям",
    knobMidway !== "" && knobMidway !== "-24px" && knobMidway !== "24px",
    `--knob-x на полпути: ${knobMidway || "(пусто)"}`
  );
  check(
    "перетянули влево — выключился",
    before === true && (await checkedOf(page, "uiGradientToggle")) === false
  );
  check(
    "после перетаскивания инлайновые стили сняты",
    await page.evaluate(
      () =>
        !document
          .querySelector("#uiGradientToggle")
          .parentElement.querySelector(".ui-switch-track")
          .getAttribute("style")
    )
  );

  // Клик должен остаться кликом: одно переключение, а не два.
  const beforeClick = await checkedOf(page, "excludeMemoryIdsToggle");
  await switchOf(page, "excludeMemoryIdsToggle").click();
  await page.waitForTimeout(150);
  check(
    "обычный клик по-прежнему переключает ровно один раз",
    (await checkedOf(page, "excludeMemoryIdsToggle")) === !beforeClick
  );

  await browser.close();
  server.close();

  let failed = 0;
  for (const c of cases) {
    if (!c.ok) failed += 1;
    console.log((c.ok ? "  ok   " : "  FAIL ") + c.name + (c.ok || !c.extra ? "" : `\n       ${c.extra}`));
  }
  for (const e of errors) {
    failed += 1;
    console.error("  FAIL ошибка на странице: " + e);
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("FATAL", e);
    process.exit(1);
  }
);
