// Простой раннер тестов без зависимостей: node tests/run.js
const suites = ["./test-api-mapping.js", "./test-api-returns.js", "./test-api-reader.js"];

(async () => {
  let passed = 0;
  let failed = 0;
  for (const s of suites) {
    const { tests } = require(s);
    for (const t of tests) {
      try {
        await t.fn();
        passed += 1;
        console.log("  ok   " + t.name);
      } catch (e) {
        failed += 1;
        console.error("  FAIL " + t.name + "\n       " + (e && e.message ? e.message : e));
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
