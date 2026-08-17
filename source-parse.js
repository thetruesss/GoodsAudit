(function () {
  const FIXED_HEADER_NAMES = {
    articleId: "Id постинга",
    operationalWarehouse: "Текущее местоположение постинга",
    shipment: "Номер постинга",
    postingType: "Тип постинга",
  };

  const HEADER_ALIASES = {
    articleId: [
      "id постинга",
      "id отправления",
      "id предмета",
      "идентификатор",
      "идентификаторы",
      "идентификатор отправления",
      "постинг",
      "постинги",
      "номер постинга",
      "отправления",
      "article id",
      "posting id",
      "postings",
      "identifier",
      "shipment id",
    ],
    operationalWarehouse: [
      "текущее местоположение постинга",
      "текущее местоположение",
      "текущее место постинга",
      "текущее место",
      "опер. склад",
      "оперативный склад",
      "операционный склад",
      "operational warehouse",
      "current location",
    ],
    shipment: [
      "номер постинга",
      "отправление",
      "posting number",
      "shipment",
      "номер отправления",
    ],
    postingType: [
      "тип постинга",
      "тип отправления",
      "вид отправления",
      "тип экземпляра",
      "тип грузоместа",
      "вид грузоместа",
      "тип объекта",
      "тип тары",
      "item type",
      "posting type",
      "cargo type",
    ],
    warehouse: ["склад", "warehouse", "локац"],
  };

  function countDelimitersOutsideQuotes(line, delimiter) {
    const text = String(line || "");
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQuotes && text[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && ch === delimiter) count += 1;
    }
    return count;
  }

  function countDelimitersInLine(line) {
    return [
      { delim: "\t", count: countDelimitersOutsideQuotes(line, "\t") },
      { delim: ";", count: countDelimitersOutsideQuotes(line, ";") },
      { delim: ",", count: countDelimitersOutsideQuotes(line, ",") },
    ];
  }

  function detectDelimiter(lines) {
    const sample = Array.isArray(lines) ? lines : [lines];
    const totals = new Map([
      ["\t", 0],
      [";", 0],
      [",", 0],
    ]);
    const limit = Math.min(sample.length, 80);
    for (let i = 0; i < limit; i++) {
      const counts = countDelimitersInLine(sample[i]);
      counts.sort((a, b) => b.count - a.count);
      if (counts[0].count <= 0) continue;
      totals.set(counts[0].delim, (totals.get(counts[0].delim) || 0) + counts[0].count);
    }
    let winner = ",";
    let bestTotal = 0;
    for (const [delim, total] of totals) {
      if (total > bestTotal) {
        bestTotal = total;
        winner = delim;
      }
    }
    if (bestTotal > 0) return winner;
    const firstCounts = countDelimitersInLine(sample[0]);
    firstCounts.sort((a, b) => b.count - a.count);
    return firstCounts[0].count > 0 ? firstCounts[0].delim : ",";
  }

  function isEmptySourceRecord(record) {
    const t = String(record || "").trim();
    if (!t) return true;
    if (/^[\t;,]+$/.test(t)) return true;
    return false;
  }

  /**
   * Split CSV/TSV text into logical records without breaking on newlines inside quotes.
   * Keeps quote characters so field splitting can unescape them later.
   */
  function splitCsvRecords(rawText) {
    const s = String(rawText || "");
    const records = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        if (inQuotes && s[i + 1] === '"') {
          cur += '""';
          i += 1;
        } else {
          inQuotes = !inQuotes;
          cur += ch;
        }
        continue;
      }
      if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && s[i + 1] === "\n") i += 1;
        if (!isEmptySourceRecord(cur)) records.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (!isEmptySourceRecord(cur)) records.push(cur);
    return records;
  }

  function splitLineWithDelimiter(line, delimiter) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    const s = String(line || "");
    const delim = delimiter == null || delimiter === "" ? "," : String(delimiter);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        if (inQuotes && s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && ch === delim) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function normalizeCellRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const out = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cells = row.map((x) => String(x ?? "").trim());
      if (!cells.some((cell) => cell.length > 0)) continue;
      out.push(cells);
    }
    return out;
  }

  function normalizeHeaderName(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ");
  }

  function looksLikeHeaderLabel(cell) {
    const s = String(cell || "").trim();
    if (!s) return false;
    if (s.length > 72) return false;
    if (/[\r\n]/.test(s)) return false;
    // Free-text conclusions / comments are not headers.
    if (s.length > 36 && /[.!?]/.test(s)) return false;
    if (s.length > 48 && /\s/.test(s) && (s.match(/\s+/g) || []).length >= 6) return false;
    return true;
  }

  function cellMatchesHint(cell, hint, opts = {}) {
    const requireHeaderLike = opts.requireHeaderLike === true;
    const h = normalizeHeaderName(cell);
    const needle = String(hint || "");
    if (!h || !needle) return false;
    if (requireHeaderLike && !looksLikeHeaderLabel(cell)) return false;
    return h === needle || h.startsWith(`${needle} `) || h.includes(needle);
  }

  function detectColumnIndex(headerCells, hintsNormalized, opts = {}) {
    const cells = Array.isArray(headerCells) ? headerCells : [];
    for (const hint of hintsNormalized) {
      const idx = cells.findIndex((cell) => cellMatchesHint(cell, hint, opts));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function detectExactColumnIndex(headerCells, exactHeaderName) {
    if (!Array.isArray(headerCells) || !exactHeaderName) return -1;
    const exact = normalizeHeaderName(exactHeaderName);
    return headerCells.findIndex((c) => normalizeHeaderName(c) === exact);
  }

  function normalizeHints(hints) {
    return (hints || []).map((h) => normalizeHeaderName(h));
  }

  const MAX_POSTING_ID_LENGTH = 35;

  function normalizePostingValue(v) {
    const raw = String(v || "").trim();
    if (!raw) return "";
    return raw
      .replace(/^["']+|["']+$/g, "")
      .replace(/^[#:;,.(){}\[\]<>]+|[#:;,.(){}\[\]<>]+$/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function hasCyrillic(s) {
    return /[А-Яа-яЁё]/.test(s);
  }

  function isCyrillicOperationalCode(s) {
    if (!/^[А-Яа-яЁё]/.test(s)) return false;
    if (!/-\d/.test(s)) return false;
    const rest = s.replace(/^[А-Яа-яЁё]+-?/u, "");
    if (/^\d{8,}/.test(rest)) return false;
    return /^[А-Яа-яЁё]{2,}-\d/.test(s);
  }

  function isUnsupportedShipmentIdPrefix(v) {
    const s = normalizePostingValue(v);
    if (!s) return false;
    if (/^BT/i.test(s)) return true;
    if (/^G/i.test(s) && s.length >= 10) return true;
    return false;
  }

  function isExcludedPostingId(v) {
    const s = normalizePostingValue(v);
    if (isUnsupportedShipmentIdPrefix(s)) return true;
    if (/^выгрузк/i.test(s)) return true;
    if (isCyrillicOperationalCode(s)) return true;
    return false;
  }

  function normalizeTypeLabel(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ");
  }

  const UNSUPPORTED_TYPE_EXACT = new Set(["bag", "тара"]);
  const UNSUPPORTED_TYPE_PREFIXES = [
    "палет",
    "паллет",
    "pallet",
    "контейнер",
    "container",
    "тоут",
    "tote",
    "тележк",
    "роллкейдж",
    "rollcage",
    "roll cage",
    "мешок",
    "gaylord",
  ];

  function isUnsupportedPostingTypeLabel(v) {
    const t = normalizeTypeLabel(v);
    if (!t) return false;
    if (t.includes("неподдерживаем")) return true;
    const compact = t.replace(/\s+/g, "");
    if (UNSUPPORTED_TYPE_EXACT.has(t) || UNSUPPORTED_TYPE_EXACT.has(compact)) return true;
    for (const prefix of UNSUPPORTED_TYPE_PREFIXES) {
      const n = prefix.replace(/\s+/g, "");
      if (t === prefix || compact === n) return true;
      if (t.startsWith(`${prefix} `) || compact.startsWith(n)) return true;
    }
    return false;
  }

  function getUnsupportedShipmentSkipReason(row) {
    if (!row || typeof row !== "object") return "";
    if (isUnsupportedShipmentIdPrefix(row.articleId) || isUnsupportedShipmentIdPrefix(row.shipmentSource)) {
      return "unsupported-id";
    }
    if (isUnsupportedPostingTypeLabel(row.postingType)) return "unsupported-type";
    return "";
  }

  function isDateLikeToken(v) {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return true;
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(s)) return true;
    return false;
  }

  function looksLikeId(v) {
    const s = String(v || "")
      .trim()
      .replace(/\u00a0/g, "")
      .replace(/\s+/g, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^[#:;,.(){}\[\]<>]+|[#:;,.(){}\[\]<>]+$/g, "");
    if (!s) return false;
    if (hasCyrillic(s)) return false;
    if (s.length > MAX_POSTING_ID_LENGTH) return false;
    if (isExcludedPostingId(s)) return false;
    if (/^\d{16}$/.test(s)) return true;
    if (s.length < 8) return false;
    if (isDateLikeToken(s)) return false;
    if (/^\d{8,}(?:-\d{1,8}){1,6}$/.test(s)) return true;
    
    if (/^\d+$/.test(s)) return s.length >= 10;
    if (/^[A-Za-z0-9]{2,8}-\d{8,}(?:-\d{1,8}){0,6}$/.test(s)) return true;
    if (/^[A-Za-z]{1,4}\d{0,4}-[A-Za-z]{1,4}\d{6,}$/.test(s)) return true;
    if (/^[A-Za-z]{1,4}\d{6,}$/.test(s)) return true;
    if (/^[A-Za-z0-9_-]{8,}$/.test(s)) {
      const digits = (s.match(/\d/g) || []).length;
      if (
        digits >= 6 &&
        (/[A-Za-z]/.test(s) || /[-_]/.test(s)) &&
        (/-|_/.test(s) || /^[A-Za-z]{1,4}\d{6,}$/.test(s))
      ) {
        return true;
      }
    }
    return false;
  }

  function extractPostingId(v, opts = {}) {
    const allowLoose = opts.allowLoose === true;
    const text = String(v || "")
      .replace(/[\u200b-\u200d\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
    if (!text) return "";

    const patterns = [
      /\b[A-Za-z]{1,4}\d{0,4}-\d{8,}(?:-\d{1,8}){0,6}\b/g,
      /\b[A-Za-z]{1,4}\d{0,4}-[A-Za-z]{1,4}\d{6,}\b/g,
      /\b\d{8,}(?:-\d{1,8}){0,6}\b/g,
      /\b[A-Za-z]{1,4}\d{6,}\b/g,
    ];
    for (const re of patterns) {
      const matches = text.match(re) || [];
      for (const m of matches) {
        const token = normalizePostingValue(m);
        if (looksLikeId(token)) return token;
      }
    }

    const chunks = text
      .split(/[\s,;|/\\()\[\]{}]+/)
      .map((x) => normalizePostingValue(x))
      .filter(Boolean);
    for (const chunk of chunks) {
      if (looksLikeId(chunk)) return chunk;
    }
    const direct = normalizePostingValue(text);
    if (looksLikeId(direct)) return direct;
    if (
      allowLoose &&
      direct.length <= MAX_POSTING_ID_LENGTH &&
      !hasCyrillic(direct) &&
      /^[A-Za-z0-9_-]{8,}$/.test(direct)
    ) {
      const digits = (direct.match(/\d/g) || []).length;
      if (
        digits >= 6 &&
        !isDateLikeToken(direct) &&
        !isExcludedPostingId(direct) &&
        (/[A-Za-z]/.test(direct) || /[-_]/.test(direct))
      ) {
        return direct;
      }
    }
    return "";
  }

  function extractHeaderPostingId(v) {
    const strict = extractPostingId(v, { allowLoose: true });
    if (strict) return strict;

    const text = String(v || "").replace(/\u00a0/g, " ").trim();
    if (text) {
      const exact16 = text.match(/\b\d{16}\b/);
      if (exact16) return String(exact16[0]);
    }

    const direct = normalizePostingValue(v);
    if (!direct) return "";
    if (hasCyrillic(direct)) return "";
    if (direct.length > MAX_POSTING_ID_LENGTH) return "";
    if (isExcludedPostingId(direct)) return "";
    if (/^\d{16}$/.test(direct)) return direct;
    if (direct.length < 8) return "";
    if (isDateLikeToken(direct)) return "";
    if (/^\d+$/.test(direct)) return direct.length >= 10 ? direct : "";
    if (/[^A-Za-z0-9_-]/.test(direct)) return "";
    const digits = (direct.match(/\d/g) || []).length;
    if (digits < 6) return "";
    if (!/[-_]/.test(direct) && !/^[A-Za-z]{1,4}\d{6,}$/.test(direct)) return "";
    return direct;
  }

  function detectArticleIdColumnsByData(cellRows, startFrom) {
    const scoreByIdx = new Map();
    const rows = Array.isArray(cellRows) ? cellRows : [];
    const takeMax = Math.min(rows.length, startFrom + 1200);
    for (let i = startFrom; i < takeMax; i++) {
      const cells = rows[i] || [];
      for (let c = 0; c < cells.length; c++) {
        if (extractPostingId(cells[c])) {
          scoreByIdx.set(c, (scoreByIdx.get(c) || 0) + 1);
        }
      }
    }
    return [...scoreByIdx.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([idx, score]) => ({ idx, score }));
  }

  function extractNamedValue(cells, idx) {
    if (idx == null || idx < 0) return "";
    return String(cells[idx] ?? "").trim();
  }

  function detectHeaderRow(cellRows, articleHints, opsHints, shipmentHints, warehouseHints, typeHints) {
    const rows = Array.isArray(cellRows) ? cellRows : [];
    const limit = Math.min(rows.length, 80);
    let bestIdx = -1;
    let bestScore = 0;
    let bestCells = [];
    const headerOpts = { requireHeaderLike: true };

    for (let i = 0; i < limit; i++) {
      const cells = rows[i] || [];
      const nonEmpty = cells.filter((x) => String(x || "").length > 0).length;
      const articleIdx = detectColumnIndex(cells, articleHints, headerOpts);
      const shipmentIdx = detectColumnIndex(cells, shipmentHints, headerOpts);
      const opsIdx = detectColumnIndex(cells, opsHints, headerOpts);
      const warehouseIdx = detectColumnIndex(cells, warehouseHints, headerOpts);
      const typeIdx = detectColumnIndex(cells, typeHints, headerOpts);

      // Single-column ID headers (just "Идентификатор") are valid.
      if (nonEmpty < 2 && !(nonEmpty === 1 && articleIdx >= 0)) continue;

      let score = 0;
      if (articleIdx >= 0) score += 7;
      if (shipmentIdx >= 0) score += 6;
      if (opsIdx >= 0) score += 2;
      if (typeIdx >= 0) score += 2;
      if (warehouseIdx >= 0) score += 1;

      // Prefer compact label rows over sparse/noisy ones when scores tie-break upward.
      const labelLike = cells.filter((c) => looksLikeHeaderLabel(c)).length;
      if (labelLike >= 3) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestCells = cells;
      }
    }

    if (bestScore >= 6) {
      return { idx: bestIdx, cells: bestCells };
    }
    return { idx: -1, cells: [] };
  }

  function emptyParseResult() {
    return {
      rows: [],
      totalNonEmptyLines: 0,
      headerSkipped: false,
      missingIdRows: 0,
      headerCells: [],
    };
  }

  function parseSourceCellRows(cellRowsInput, includeSourceCells) {
    const wantCells = includeSourceCells !== false;
    const cellRows = normalizeCellRows(cellRowsInput);
    if (!cellRows.length) return emptyParseResult();

    const normalizedArticleHints = normalizeHints(HEADER_ALIASES.articleId);
    const normalizedOpsHints = normalizeHints(HEADER_ALIASES.operationalWarehouse);
    const normalizedShipmentHints = normalizeHints(HEADER_ALIASES.shipment);
    const normalizedWarehouseHints = normalizeHints(HEADER_ALIASES.warehouse);
    const normalizedTypeHints = normalizeHints(HEADER_ALIASES.postingType);

    const headerRow = detectHeaderRow(
      cellRows,
      normalizedArticleHints,
      normalizedOpsHints,
      normalizedShipmentHints,
      normalizedWarehouseHints,
      normalizedTypeHints
    );
    const hasHeader = headerRow.idx >= 0;

    const startFrom = hasHeader ? headerRow.idx + 1 : 0;
    const headerCells = hasHeader ? headerRow.cells : [];
    let articleIdIdx =
      hasHeader ? detectExactColumnIndex(headerCells, FIXED_HEADER_NAMES.articleId) : -1;
    const operationalWarehouseIdx =
      hasHeader
        ? detectExactColumnIndex(headerCells, FIXED_HEADER_NAMES.operationalWarehouse)
        : -1;
    const shipmentIdx =
      hasHeader ? detectExactColumnIndex(headerCells, FIXED_HEADER_NAMES.shipment) : -1;
    let postingTypeIdx =
      hasHeader ? detectExactColumnIndex(headerCells, FIXED_HEADER_NAMES.postingType) : -1;
    if (postingTypeIdx < 0 && hasHeader) {
      postingTypeIdx = detectColumnIndex(headerCells, normalizedTypeHints);
    }
    const warehouseIdx = hasHeader ? detectColumnIndex(headerCells, normalizedWarehouseHints) : -1;
    const headerIdColumns = hasHeader
      ? [...new Set([
          detectColumnIndex(headerCells, normalizedArticleHints),
          detectColumnIndex(headerCells, normalizedShipmentHints),
        ].filter((idx) => idx >= 0))]
      : [];
    if (articleIdIdx < 0 && hasHeader) {
      articleIdIdx = detectColumnIndex(headerCells, normalizedArticleHints);
    }
    const candidateIdColumnsScored = detectArticleIdColumnsByData(cellRows, startFrom);
    const bestScore = candidateIdColumnsScored[0]?.score || 0;
    const minScore = Math.max(1, Math.floor(bestScore * 0.35));
    const candidateIdColumns = candidateIdColumnsScored
      .filter((x) => x.score >= minScore)
      .map((x) => x.idx)
      .slice(0, 6);
    if (articleIdIdx < 0) {
      articleIdIdx = candidateIdColumns.length ? candidateIdColumns[0] : -1;
    }
    const headerSearchColumns = [...headerIdColumns];
    const patternSearchColumns = [articleIdIdx, ...candidateIdColumns].filter(
      (idx, pos, arr) => idx >= 0 && arr.indexOf(idx) === pos
    );
    const useHeaderPriority = headerSearchColumns.length > 0;

    const rowsByHeader = [];
    const rowsByPattern = [];
    let inspectedRows = 0;
    let maxCellCount = 0;

    function makeParsedRow(articleId, cells) {
      const warehouse = warehouseIdx >= 0 ? String(cells[warehouseIdx] || "").trim() : "";
      const operationalWarehouse = extractNamedValue(cells, operationalWarehouseIdx);
      const shipmentSource = extractNamedValue(cells, shipmentIdx);
      const postingType = extractNamedValue(cells, postingTypeIdx);
      const sourceNamed = {
        articleId,
        operationalWarehouse,
        shipment: shipmentSource,
        postingType,
      };
      if (wantCells) {
        return {
          warehouse,
          articleId,
          operationalWarehouse,
          shipmentSource,
          postingType,
          sourceNamed,
          sourceCells: cells.slice(),
        };
      }
      return { warehouse, articleId, operationalWarehouse, shipmentSource, postingType, sourceNamed };
    }

    for (let i = startFrom; i < cellRows.length; i++) {
      if (hasHeader && i === headerRow.idx) continue;
      const cells = cellRows[i] || [];
      if (!cells.some((cell) => String(cell).trim().length > 0)) continue;
      inspectedRows += 1;
      if (wantCells && cells.length > maxCellCount) maxCellCount = cells.length;

      let headerArticleId = "";
      for (const idx of headerSearchColumns) {
        headerArticleId = extractHeaderPostingId(cells[idx] || "");
        if (headerArticleId) break;
      }

      let patternArticleId = "";
      for (const idx of patternSearchColumns) {
        patternArticleId = extractPostingId(cells[idx] || "", { allowLoose: false });
        if (patternArticleId) break;
      }
      if (!patternArticleId && !patternSearchColumns.length) {
        for (const cell of cells) {
          patternArticleId = extractPostingId(cell, { allowLoose: false });
          if (patternArticleId) break;
        }
      }

      if (headerArticleId) {
        rowsByHeader.push(makeParsedRow(headerArticleId, cells));
      }
      if (patternArticleId) {
        rowsByPattern.push(makeParsedRow(patternArticleId, cells));
      }
    }

    let rows = rowsByPattern;
    let missingIdRows = Math.max(0, inspectedRows - rowsByPattern.length);
    if (useHeaderPriority && rowsByHeader.length >= rowsByPattern.length) {
      rows = rowsByHeader;
      missingIdRows = Math.max(0, inspectedRows - rowsByHeader.length);
    }
    if (wantCells && maxCellCount > 0) {
      for (const row of rows) {
        if (!Array.isArray(row.sourceCells)) continue;
        while (row.sourceCells.length < maxCellCount) row.sourceCells.push("");
      }
    }
    return {
      rows,
      totalNonEmptyLines: cellRows.length,
      headerSkipped: hasHeader,
      missingIdRows,
      headerCells: hasHeader ? headerCells.map((x) => String(x || "").trim()) : [],
    };
  }

  globalThis.__returnsSplitCsvRecords = splitCsvRecords;

  globalThis.__returnsParseSourceCellRows = function parseSourceCellRowsExport(
    cellRows,
    includeSourceCells
  ) {
    return parseSourceCellRows(cellRows, includeSourceCells);
  };

  globalThis.__returnsParseSourceRows = function parseSourceRows(rawText, includeSourceCells) {
    const records = splitCsvRecords(rawText);
    if (!records.length) return emptyParseResult();
    const delimiter = detectDelimiter(records);
    const cellRows = records.map((line) =>
      splitLineWithDelimiter(line, delimiter).map((x) => String(x || "").trim())
    );
    return parseSourceCellRows(cellRows, includeSourceCells);
  };

  globalThis.__returnsLooksLikeId = looksLikeId;
  globalThis.__returnsGetUnsupportedShipmentSkipReason = getUnsupportedShipmentSkipReason;
})();
