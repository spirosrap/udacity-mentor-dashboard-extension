// ==UserScript==
// @name         Udacity Mentor Dashboard — Daily Income Counter
// @namespace    https://mentor-dashboard.udacity.com/
// @version      1.1.0
// @description  Sum today's earned income from Reviews + Questions and show totals with completed counts at the bottom of the page.
// @match        https://mentor-dashboard.udacity.com/queue/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // "Today" timezone for the daily total (uses IANA tz database).
  // Greece: Europe/Athens (handles DST automatically).
  const TODAY_TIME_ZONE = 'Europe/Athens';

  const BAR_ID = 'tm-udacity-daily-income-bar';
  const IFRAME_ID = 'tm-udacity-history-iframe';
  const DETAILS_KEY = 'tmUdacityDailyIncomeDetailsOpen';
  const TARGET_DAY_KEY = 'tmUdacityDailyIncomeTargetDay'; // "YYYY-MM-DD" in TODAY_TIME_ZONE terms
  let lastBackgroundError = '';
  let lastStatus = 'loading'; // loading | ready | error
  const DISCOVERY_KEY = 'tmUdacityDailyIncomeApiDiscovery';
  const DISCOVERY_LOG_KEY = 'tmUdacityDailyIncomeApiDiscoveryLog';
  const DISCOVERY_LOG_MAX_CHARS = 8000;
  const CACHE_KEY = 'tmUdacityDailyIncomeCache';
  const BEST_LOCK_KEY = 'tmUdacityDailyIncomeBestByDay';
  let recomputeInFlight = false;
  let recomputeQueued = false;
  let lastRenderSignature = '';
  let lastApiFetchAt = 0;
  let discoveryInstalled = false;
  let lastDataSource = 'none'; // api | history | cache | none
  let lastApiFailure = '';
  const DEFAULT_RIGHT_PX = 14;
  const DEFAULT_BOTTOM_PX = 14;
  const ANCHOR_GAP_PX = 14;
  const SAFE_FALLBACK_CLEARANCE_PX = 70;

  const MONTHS = Object.freeze({
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  });

  function hasDomScaffold() {
    return !!(document.head && document.body);
  }

  async function waitForDomScaffold(timeoutMs = 30000) {
    const started = Date.now();
    while (!hasDomScaffold()) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  function formatMoney(n) {
    const safe = Number.isFinite(n) ? n : 0;
    return safe.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  function getTodayParts(timeZone) {
    // Returns calendar parts { y, m, d } for "today" in the desired timezone.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      y: Number(get('year')),
      m: Number(get('month')),
      d: Number(get('day')),
    };
  }

  function partsToDayKey(parts) {
    if (!parts) return '';
    return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  }

  function parseDayKeyToParts(key) {
    // key: "YYYY-MM-DD"
    if (!key) return null;
    const m = String(key).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d };
  }

  function compareYMD(a, b) {
    // Returns -1 if a<b, 0 if equal, +1 if a>b
    if (!a || !b) return 0;
    if (a.y !== b.y) return a.y < b.y ? -1 : 1;
    if (a.m !== b.m) return a.m < b.m ? -1 : 1;
    if (a.d !== b.d) return a.d < b.d ? -1 : 1;
    return 0;
  }

  function getTargetDayParts() {
    try {
      const raw = localStorage.getItem(TARGET_DAY_KEY);
      const parsed = parseDayKeyToParts(raw);
      if (parsed) return parsed;
    } catch (_) {}
    return getTodayParts(TODAY_TIME_ZONE);
  }

  function setTargetDayParts(parts) {
    try {
      const key = partsToDayKey(parts);
      if (key) localStorage.setItem(TARGET_DAY_KEY, key);
    } catch (_) {}
  }

  function getPartsForDate(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      y: Number(get('year')),
      m: Number(get('month')),
      d: Number(get('day')),
    };
  }

  function parseMoney(text) {
    if (!text) return null;
    const m = String(text).match(/\$[\s]*([\d,]+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseMonthDayYear(text) {
    // Expected like: "January 23, 2026"
    if (!text) return null;
    const m = String(text).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (!m) return null;
    const monthName = m[1].toLowerCase();
    const month = MONTHS[monthName];
    if (!month) return null;
    return {
      y: Number(m[3]),
      m: month,
      d: Number(m[2]),
    };
  }

  function sameYMD(a, b) {
    return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
  }

  function tryParseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Heuristic: if it's likely epoch seconds (10 digits), convert to ms.
      const ms = value < 1e12 && value > 1e9 ? value * 1000 : value;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
      // ISO-ish timestamps from APIs.
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
      // Fallback for UI-style "January 23, 2026".
      const mdY = parseMonthDayYear(value);
      if (mdY) return new Date(Date.UTC(mdY.y, mdY.m - 1, mdY.d));
    }
    return null;
  }

  function findHeadingByText(text) {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
    return headings.find((h) => (h.textContent || '').trim() === text) || null;
  }

  function findHeadingByTextIn(doc, text) {
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
    return headings.find((h) => (h.textContent || '').trim() === text) || null;
  }

  function nodesBetween(startNode, endNode, nodes) {
    // Filters `nodes` to those that appear in DOM order after startNode and before endNode.
    return nodes.filter((node) => {
      if (!startNode || !node) return false;
      const afterStart = !!(startNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
      const beforeEnd = endNode
        ? !!(endNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)
        : true;
      return afterStart && beforeEnd;
    });
  }

  function splitRowsByTerminator(cells, terminatorRe) {
    const rows = [];
    let cur = [];
    for (const el of cells) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      cur.push(t);
      if (terminatorRe.test(t)) {
        rows.push(cur);
        cur = [];
      }
    }
    return rows;
  }

  function isDisabledish(el) {
    if (!el) return true;
    if (el.disabled) return true;
    const aria = (el.getAttribute && el.getAttribute('aria-disabled')) || '';
    if (String(aria).toLowerCase() === 'true') return true;
    const cls = (el.className && String(el.className)) || '';
    if (/disabled/i.test(cls)) return true;
    return false;
  }

  function paginationLabel(el) {
    if (!el) return '';
    const t = (el.textContent || '').trim();
    const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
    const title = (el.getAttribute && el.getAttribute('title')) || '';
    const rel = (el.getAttribute && el.getAttribute('rel')) || '';
    const dataTestId = (el.getAttribute && el.getAttribute('data-testid')) || '';
    return `${t} ${aria} ${title} ${rel} ${dataTestId}`.trim().toLowerCase();
  }

  function matchesPaginationDirection(el, dir) {
    const s = paginationLabel(el);
    if (!s) return false;
    if (dir === 'next') {
      if (s.includes('previous') || s.includes('prev')) return false;
      if (s.includes('newer')) return false;
      if (s.includes('next')) return true;
      if (s.includes('go to next')) return true;
      if (s.includes('navigate next')) return true;
      // Udacity History uses "Older" / "Newer"
      if (s.includes('older')) return true;
      if (s.includes('›') || s.includes('→') || s.includes('chevronright')) return true;
      if (s.includes('pagination-next') || s.includes('next-page')) return true;
      return false;
    }
    if (dir === 'prev') {
      if (s.includes('next')) return false;
      if (s.includes('older')) return false;
      if (s.includes('previous') || s.includes('prev')) return true;
      if (s.includes('go to previous')) return true;
      if (s.includes('navigate previous')) return true;
      // Udacity History uses "Older" / "Newer"
      if (s.includes('newer')) return true;
      if (s.includes('‹') || s.includes('←') || s.includes('chevronleft')) return true;
      if (s.includes('pagination-prev') || s.includes('prev-page') || s.includes('previous-page')) return true;
      return false;
    }
    return false;
  }

  function nearestCommonAncestor(a, b) {
    if (!a || !b) return null;
    const aAnc = [];
    let cur = a;
    while (cur) { aAnc.push(cur); cur = cur.parentElement; }
    cur = b;
    while (cur) {
      if (aAnc.includes(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function uniqElements(list) {
    const out = [];
    const seen = new Set();
    for (const el of list) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  function getSectionGridCells(doc, { startHeadingText, endHeadingText }) {
    const start = findHeadingByTextIn(doc, startHeadingText);
    if (!start) return [];
    const end = endHeadingText ? findHeadingByTextIn(doc, endHeadingText) : null;
    const gridCells = Array.from(doc.querySelectorAll('[role="gridcell"]'));
    return nodesBetween(start, end, gridCells);
  }

  async function waitForSectionRows(doc, sectionCfg, rowTerminatorRe, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const cells = getSectionGridCells(doc, sectionCfg);
      if (cells && cells.length) {
        const rows = splitRowsByTerminator(cells, rowTerminatorRe || /^View (review|question)$/i);
        if (rows.length) return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async function waitForPaginationReady(doc, sectionCfg, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rowsReady = await waitForSectionRows(doc, sectionCfg, sectionCfg.rowTerminatorRe, 350);
      if (!rowsReady) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      const nextCandidates = collectPaginationCandidates(doc, sectionCfg, 'next');
      // As soon as at least one candidate exists (enabled or disabled), pagination UI is likely mounted.
      if (nextCandidates.length > 0) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  function collectPaginationCandidates(doc, sectionCfg, dir) {
    const start = findHeadingByTextIn(doc, sectionCfg.startHeadingText);
    if (!start) return [];
    const end = sectionCfg.endHeadingText ? findHeadingByTextIn(doc, sectionCfg.endHeadingText) : null;
    const all = Array.from(doc.querySelectorAll('button,[role="button"],a'));
    const scoped = nodesBetween(start, end, all);

    const gridCells = getSectionGridCells(doc, sectionCfg);
    const first = gridCells[0] || null;
    const last = gridCells.length ? gridCells[gridCells.length - 1] : null;
    const anc = nearestCommonAncestor(first, last);
    const near = anc ? Array.from(anc.querySelectorAll('button,[role="button"],a')) : [];

    const pooled = uniqElements([...near, ...scoped, ...all]);
    const matched = pooled.filter((el) => matchesPaginationDirection(el, dir));
    const score = (el) => {
      const s = paginationLabel(el);
      let v = 0;
      if (dir === 'next') {
        if (/\bolder\b/.test(s)) v += 80; // Udacity-specific and most reliable
        if (/\bnext\b/.test(s)) v += 45;
      } else {
        if (/\bnewer\b/.test(s)) v += 80; // Udacity-specific and most reliable
        if (/\bprevious\b|\bprev\b/.test(s)) v += 45;
      }
      if (/pagination|page/.test(s)) v += 12;
      if ((el.tagName || '').toLowerCase() === 'button') v += 8;
      if (isDisabledish(el)) v -= 100;
      return v;
    };
    return matched.sort((a, b) => score(b) - score(a));
  }

  function sectionSignature(doc, { startHeadingText, endHeadingText, rowTerminatorRe }) {
    const start = findHeadingByTextIn(doc, startHeadingText);
    if (!start) return '';
    const end = endHeadingText ? findHeadingByTextIn(doc, endHeadingText) : null;
    const gridCells = Array.from(doc.querySelectorAll('[role="gridcell"]'));
    const scopedCells = nodesBetween(start, end, gridCells);
    const terminator = rowTerminatorRe || /^View (review|question)$/i;
    const rows = splitRowsByTerminator(scopedCells, terminator);
    if (!rows.length) {
      // Fallback: sample from both ends, not only the top (top can be static headers).
      const head = scopedCells.slice(0, 12);
      const tail = scopedCells.slice(-12);
      return [...head, ...tail]
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .join('|');
    }

    const summarizeRow = (row) => {
      const earned = row.map(parseMoney).find((n) => n != null) ?? null;
      const completed = row.map(parseMonthDayYear).find((d) => d != null) ?? null;
      const dateKey = completed ? `${completed.y}-${String(completed.m).padStart(2, '0')}-${String(completed.d).padStart(2, '0')}` : '';
      return `${dateKey}|${earned != null ? earned : ''}`;
    };

    const first = rows[0];
    const last = rows[rows.length - 1];
    const mid = rows[Math.floor(rows.length / 2)];
    return `rows=${rows.length}|first=${summarizeRow(first)}|mid=${summarizeRow(mid)}|last=${summarizeRow(last)}`;
  }

  async function clickNextAndWait(doc, sectionCfg, nextEl, prevSig, timeoutMs = 4500) {
    const started = Date.now();
    try { nextEl.click(); } catch (_) {}
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
      const sig = sectionSignature(doc, sectionCfg);
      if (sig && sig !== prevSig) {
        // Wait for rows to actually appear after a paging click (SPA often clears rows while loading).
        await waitForSectionRows(doc, sectionCfg, sectionCfg.rowTerminatorRe, 6000);
        return true;
      }
    }
    return false;
  }

  async function clickPrevAndWait(doc, sectionCfg, prevEl, prevSig, timeoutMs = 4500) {
    const started = Date.now();
    try { prevEl.click(); } catch (_) {}
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
      const sig = sectionSignature(doc, sectionCfg);
      if (sig && sig !== prevSig) {
        await waitForSectionRows(doc, sectionCfg, sectionCfg.rowTerminatorRe, 6000);
        return true;
      }
    }
    return false;
  }

  async function rewindSectionToFirstPage(doc, sectionCfg) {
    const MAX_STEPS = 30;
    let steps = 0;
    while (steps < MAX_STEPS) {
      const sig = sectionSignature(doc, sectionCfg);
      const candidates = collectPaginationCandidates(doc, sectionCfg, 'prev').slice(0, 6);
      let advanced = false;
      for (const prev of candidates) {
        if (!prev || isDisabledish(prev)) continue;
        const ok = await clickPrevAndWait(doc, sectionCfg, prev, sig);
        if (ok) { advanced = true; break; }
      }
      if (!advanced) return;
      steps += 1;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  function computeSectionSumIn(doc, { startHeadingText, endHeadingText, rowTerminatorRe }) {
    const start = findHeadingByTextIn(doc, startHeadingText);
    if (!start) return { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 };
    const end = endHeadingText ? findHeadingByTextIn(doc, endHeadingText) : null;
    const targetDay = getTargetDayParts();

    const gridCells = Array.from(doc.querySelectorAll('[role="gridcell"]'));
    const scopedCells = nodesBetween(start, end, gridCells);
    const rows = splitRowsByTerminator(scopedCells, rowTerminatorRe);

    let sum = 0;
    let rowsCounted = 0;
    let maxCompleted = null;
    for (const row of rows) {
      const earned = row.map(parseMoney).find((n) => n != null) ?? null;
      const completed = row.map(parseMonthDayYear).find((d) => d != null) ?? null;
      if (earned == null || !completed) continue;
      if (!maxCompleted || compareYMD(completed, maxCompleted) > 0) maxCompleted = completed;
      if (!sameYMD(completed, targetDay)) continue;
      sum += earned;
      rowsCounted += 1;
    }

    return { sum, found: true, rowsCounted, rowsSeen: rows.length, maxCompleted };
  }

  async function computeSectionSumPaginatedIn(doc, { startHeadingText, endHeadingText, rowTerminatorRe }) {
    const targetDay = getTargetDayParts();
    const sectionCfg = { startHeadingText, endHeadingText, rowTerminatorRe };
    const MAX_PAGES = 30;
    let pages = 0;
    let sum = 0;
    let rowsCounted = 0;
    let rowsSeen = 0;

    // Start from the first page so results are accumulated deterministically.
    await rewindSectionToFirstPage(doc, sectionCfg);
    // Give the section a short moment to mount pagination controls (Older/Newer) before first compute.
    await waitForPaginationReady(doc, sectionCfg, 4000);
    // Ensure the first page rows are actually rendered before computing.
    await waitForSectionRows(doc, sectionCfg, rowTerminatorRe, 15000);

    while (pages < MAX_PAGES) {
      const cur = computeSectionSumIn(doc, { startHeadingText, endHeadingText, rowTerminatorRe });
      if (!cur.found) return cur;
      sum += cur.sum;
      rowsCounted += cur.rowsCounted;
      rowsSeen += cur.rowsSeen;

      // If this page is entirely older than the target day, stop.
      if (cur.maxCompleted && compareYMD(cur.maxCompleted, targetDay) < 0) break;

      const prevSig = sectionSignature(doc, sectionCfg);
      let candidates = collectPaginationCandidates(doc, sectionCfg, 'next').slice(0, 6);
      // If the whole visible page matches target day and we didn't find pagination yet,
      // wait briefly for the pager to mount to avoid locking into page-1 totals.
      if (!candidates.length && cur.rowsSeen > 0 && cur.rowsCounted === cur.rowsSeen) {
        await waitForPaginationReady(doc, sectionCfg, 2500);
        candidates = collectPaginationCandidates(doc, sectionCfg, 'next').slice(0, 6);
      }
      let advanced = false;
      for (const next of candidates) {
        if (!next || isDisabledish(next)) continue;
        const ok = await clickNextAndWait(doc, sectionCfg, next, prevSig);
        if (ok) { advanced = true; break; }
      }
      if (!advanced) break;
      pages += 1;
    }

    return { sum, found: true, rowsCounted, rowsSeen, pages: pages + 1 };
  }

  function isHistoryRoute() {
    return window.location.pathname.includes('/queue/history');
  }

  function loadDiscovery() {
    try {
      const raw = localStorage.getItem(DISCOVERY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function hasAnyApiEndpoint(discovery) {
    const r = discovery?.endpoints?.reviews ? String(discovery.endpoints.reviews) : '';
    const q = discovery?.endpoints?.questions ? String(discovery.endpoints.questions) : '';
    return !!(isUsableApiEndpointUrl(r) || isUsableApiEndpointUrl(q));
  }

  function hasApiEndpoint(discovery, type) {
    if (!discovery?.endpoints) return false;
    if (type === 'review') return isUsableApiEndpointUrl(discovery.endpoints.reviews);
    if (type === 'question') return isUsableApiEndpointUrl(discovery.endpoints.questions);
    return false;
  }

  function isUsableApiEndpointUrl(u) {
    if (!u) return false;
    const s = String(u);
    const lower = s.toLowerCase();
    // Known false-positive endpoint (not payouts/history).
    if (lower.includes('/certifications') || lower.includes('certifications.json')) return false;
    return true;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function pruneStorageForWrites() {
    // Keep discovery data bounded so cache writes don't fail under localStorage quota.
    try {
      const log = localStorage.getItem(DISCOVERY_LOG_KEY) || '';
      if (log.length > DISCOVERY_LOG_MAX_CHARS) {
        localStorage.setItem(DISCOVERY_LOG_KEY, log.slice(-DISCOVERY_LOG_MAX_CHARS));
      } else if (log.length > Math.floor(DISCOVERY_LOG_MAX_CHARS * 0.75)) {
        localStorage.setItem(DISCOVERY_LOG_KEY, log.slice(-Math.floor(DISCOVERY_LOG_MAX_CHARS * 0.5)));
      }
    } catch (_) {}

    try {
      const raw = localStorage.getItem(DISCOVERY_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return;
      if (Array.isArray(d.candidates) && d.candidates.length > 10) d.candidates = d.candidates.slice(0, 10);
      if (d.lastParsed && typeof d.lastParsed === 'object' && Array.isArray(d.lastParsed.keyHints) && d.lastParsed.keyHints.length > 12) {
        d.lastParsed.keyHints = d.lastParsed.keyHints.slice(0, 12);
      }
      localStorage.setItem(DISCOVERY_KEY, JSON.stringify(d));
    } catch (_) {}
  }

  function safeSetLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      try { pruneStorageForWrites(); } catch (_) {}
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function saveCache(obj) {
    try { safeSetLocalStorage(CACHE_KEY, JSON.stringify(obj)); } catch (_) {}
  }

  function loadBestByDay() {
    try {
      const raw = localStorage.getItem(BEST_LOCK_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveBestByDay(obj) {
    try { safeSetLocalStorage(BEST_LOCK_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }

  function loadBestLock(dayKey) {
    const all = loadBestByDay();
    return (all && typeof all === 'object') ? (all[dayKey] || null) : null;
  }

  function saveBestLock(dayKey, payload) {
    if (!dayKey || !payload) return;
    const all = loadBestByDay();
    const prev = (all && typeof all === 'object') ? (all[dayKey] || null) : null;
    if (!shouldOverwriteDayCache(prev, payload)) return;
    const next = {
      reviews: payload.reviews || 0,
      questions: payload.questions || 0,
      countedReviews: payload.countedReviews || 0,
      countedQuestions: payload.countedQuestions || 0,
      at: Date.now(),
    };
    const merged = (all && typeof all === 'object') ? { ...all, [dayKey]: next } : { [dayKey]: next };
    const keys = Object.keys(merged).sort((a, b) => (a < b ? 1 : -1));
    for (const k of keys.slice(31)) delete merged[k];
    saveBestByDay(merged);
  }

  function saveDiscovery(obj) {
    try { safeSetLocalStorage(DISCOVERY_KEY, JSON.stringify(obj)); } catch (_) {}
  }

  function logDiscovery(line) {
    try {
      const existing = localStorage.getItem(DISCOVERY_LOG_KEY) || '';
      const next = `${existing}\n${new Date().toISOString()} ${line}`.trim();
      const trimmed = next.length > DISCOVERY_LOG_MAX_CHARS
        ? next.slice(-DISCOVERY_LOG_MAX_CHARS)
        : next;
      safeSetLocalStorage(DISCOVERY_LOG_KEY, trimmed);
    } catch (_) {}
  }

  function getStringish(obj, keys) {
    for (const k of keys) {
      if (obj && typeof obj === 'object' && k in obj) return obj[k];
    }
    return undefined;
  }

  function toMoneyNumber(v, hintKey) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      // If the field name hints at cents, convert.
      if (hintKey && typeof hintKey === 'string' && /cent/i.test(hintKey) && Math.abs(v) >= 1) return v / 100;
      return v;
    }
    if (typeof v === 'string') return parseMoney(v) ?? (Number.isFinite(Number(v)) ? Number(v) : null);
    if (Array.isArray(v)) {
      for (const el of v) {
        const n = toMoneyNumber(el, hintKey);
        if (n != null) return n;
      }
      return null;
    }
    if (v && typeof v === 'object') {
      // Common shapes: { amount: 12.34, currency: "USD" } / { value: 12.34 } / { cents: 1234 }
      const amt = toMoneyNumber(v.amount, 'amount');
      if (amt != null) return amt;
      const val = toMoneyNumber(v.value, 'value');
      if (val != null) return val;
      const cents = toMoneyNumber(v.cents, 'cents');
      if (cents != null) return cents;
      const minor = toMoneyNumber(v.minor, 'minor');
      if (minor != null) return minor;
    }
    return null;
  }

  function scoreAmountKey(key, valNum) {
    if (valNum == null || !Number.isFinite(valNum)) return -Infinity;
    const abs = Math.abs(valNum);
    if (abs === 0) return -5;
    if (abs > 2000) return -50;
    let s = 0;
    const k = String(key || '').toLowerCase();
    if (k.includes('earned') || k.includes('earning')) s += 40;
    if (k.includes('payout') || k.includes('payment') || k.includes('paid')) s += 35;
    if (k.includes('amount') || k.includes('fee') || k.includes('usd') || k.includes('value') || k.includes('total')) s += 15;
    if (k.includes('cent')) s += 5;
    if (String(valNum).includes('.')) s += 3;
    return s;
  }

  function scoreDateKey(key, dt) {
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return -Infinity;
    const t = dt.getTime();
    const now = Date.now();
    if (t < Date.UTC(2018, 0, 1) || t > now + 7 * 24 * 3600 * 1000) return -50;
    let s = 0;
    const k = String(key || '').toLowerCase();
    if (k.includes('completed') || k.includes('finished')) s += 40;
    if (k.includes('submitted') || k.includes('created')) s += 10;
    if (k.includes('date') || k.includes('time') || k.includes('timestamp') || k.includes('at')) s += 8;
    return s;
  }

  function guessAmountAndDateFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    let bestAmount = null;
    let bestDate = null;
    let bestAmountScore = -Infinity;
    let bestDateScore = -Infinity;

    for (const [k, v] of Object.entries(obj)) {
      const visit = (val) => {
        // Amount candidates
        const n = toMoneyNumber(val, k);
        const as = scoreAmountKey(k, n);
        if (as > bestAmountScore) {
          bestAmountScore = as;
          bestAmount = n;
        }
        // Date candidates
        const d = tryParseDate(val);
        const ds = scoreDateKey(k, d);
        if (ds > bestDateScore) {
          bestDateScore = ds;
          bestDate = d;
        }
      };
      if (Array.isArray(v)) {
        for (const el of v) visit(el);
      } else {
        visit(v);
      }
    }

    if (bestAmount != null && bestDate) return { earned: bestAmount, date: bestDate };
    return null;
  }

  function guessAmountAndDateDeep(root, maxDepth = 4) {
    if (!root || typeof root !== 'object') return null;
    let bestAmount = null;
    let bestDate = null;
    let bestAmountScore = -Infinity;
    let bestDateScore = -Infinity;

    const stack = [{ v: root, k: '', depth: 0 }];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      const v = cur.v;
      const k = cur.k;
      const depth = cur.depth;
      if (!v || typeof v !== 'object') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (depth > maxDepth) continue;

      if (Array.isArray(v)) {
        for (const el of v) stack.push({ v: el, k, depth: depth + 1 });
        continue;
      }

      for (const [kk, vv] of Object.entries(v)) {
        const key = kk || k;
        const n = toMoneyNumber(vv, key);
        const as = scoreAmountKey(key, n);
        if (as > bestAmountScore) {
          bestAmountScore = as;
          bestAmount = n;
        }
        const d = tryParseDate(vv);
        const ds = scoreDateKey(key, d);
        if (ds > bestDateScore) {
          bestDateScore = ds;
          bestDate = d;
        }
        if (vv && typeof vv === 'object') stack.push({ v: vv, k: key, depth: depth + 1 });
      }
    }

    if (bestAmount != null && bestDate) return { earned: bestAmount, date: bestDate };
    return null;
  }

  function classifyItemType(obj, fallback) {
    const typeVal = String(getStringish(obj, ['type', 'taskType', 'workType', 'itemType', 'kind']) || '').toLowerCase();
    if (typeVal.includes('review')) return 'review';
    if (typeVal.includes('question') || typeVal.includes('comment') || typeVal.includes('answer')) return 'question';
    return fallback;
  }

  function extractItemsFromAny(payload, fallbackType) {
    // Walk the payload and collect objects that look like history items.
    const items = [];
    const sigs = new Set();
    const seen = new Set();

    const stack = [payload];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }

      // Try interpret current object as an item.
      const earnedRaw = getStringish(cur, [
        'earned', 'earning', 'earnings', 'earnedAmount', 'earned_amount',
        'amount', 'amountUsd', 'amount_usd', 'payout', 'payoutAmount', 'payout_amount',
        'payment', 'paymentAmount', 'payment_amount', 'compensation', 'fee',
        'usd', 'value', 'total', 'totalAmount', 'total_amount', 'price', 'rate',
        'amountCents', 'amount_cents', 'payoutCents', 'payout_cents', 'earnedCents', 'earned_cents',
      ]);
      const dateRaw = getStringish(cur, [
        'completed', 'completedAt', 'completed_at', 'completedOn', 'completed_on', 'completedDate', 'completed_date',
        'submittedAt', 'submitted_at', 'createdAt', 'created_at', 'finishedAt', 'finished_at',
        'date', 'timestamp', 'time', 'at',
      ]);
      const earned = toMoneyNumber(earnedRaw);
      const date = tryParseDate(dateRaw);
      if (earned != null && date) {
        const type = classifyItemType(cur, fallbackType);
        const sig = `${type || ''}|${date.getTime()}|${earned}`;
        if (!sigs.has(sig)) {
          sigs.add(sig);
          items.push({
            earned,
            completedDate: date,
            type,
          });
        }
      } else {
        // Heuristic fallback: find "some amount" + "some date" within the same object.
        const guessed = guessAmountAndDateFromObject(cur);
        const deep = guessed || guessAmountAndDateDeep(cur);
        if (deep) {
          const type = classifyItemType(cur, fallbackType);
          const sig = `${type || ''}|${deep.date.getTime()}|${deep.earned}`;
          if (!sigs.has(sig)) {
            sigs.add(sig);
            items.push({
              earned: deep.earned,
              completedDate: deep.date,
              type,
            });
          }
        }
      }

      // Continue walk.
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
    return items;
  }

  function computeTotalsFromItems(items, targetDayParts) {
    const target = targetDayParts || getTargetDayParts();
    let reviews = 0;
    let questions = 0;
    let countedReviews = 0;
    let countedQuestions = 0;

    for (const it of items) {
      const parts = getPartsForDate(it.completedDate, TODAY_TIME_ZONE);
      if (!sameYMD(parts, target)) continue;
      if (it.type === 'review') {
        reviews += it.earned;
        countedReviews += 1;
      } else if (it.type === 'question') {
        questions += it.earned;
        countedQuestions += 1;
      }
    }

    return {
      reviews,
      questions,
      countedReviews,
      countedQuestions,
    };
  }

  function summarizeItems(items) {
    let reviewItems = 0;
    let questionItems = 0;
    for (const it of items) {
      if (it.type === 'review') reviewItems += 1;
      else if (it.type === 'question') questionItems += 1;
    }
    const todayTotals = computeTotalsFromItems(items, getTodayParts(TODAY_TIME_ZONE));
    return {
      itemsTotal: items.length,
      reviewItems,
      questionItems,
      ...todayTotals,
      sample: items[0]
        ? {
            earned: items[0].earned,
            completedDate: items[0].completedDate?.toISOString?.() || String(items[0].completedDate),
            type: items[0].type,
          }
        : null,
    };
  }

  function collectKeyHints(payload) {
    const hints = new Set();
    const stack = [payload];
    const seen = new Set();
    const keyRe = /(earn|payout|pay|amount|comp|fee|usd|value|cent|total|rate|price|completed|finish|submit|create|date|time|timestamp|at)/i;
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      for (const k of Object.keys(cur)) {
        if (keyRe.test(k)) hints.add(k);
        stack.push(cur[k]);
      }
      if (hints.size >= 40) break;
    }
    return Array.from(hints).slice(0, 40);
  }

  function installNetworkDiscoveryHooks() {
    if (discoveryInstalled || window.__tmUdacityDailyIncomeDiscoveryInstalled) return;
    discoveryInstalled = true;
    window.__tmUdacityDailyIncomeDiscoveryInstalled = true;

    const isSameOriginish = (u) =>
      typeof u === 'string' && (u.startsWith('/') || u.includes(window.location.origin));

    const interestingUrl = (u) => {
      if (!isSameOriginish(u) && !(typeof u === 'string' && u.includes('mentor-dashboard.udacity.com'))) return false;
      // On the History page, capture *all* same-origin JSON calls (history data may be GraphQL or generic endpoints).
      if (window.location.pathname.includes('/queue/history')) return true;
      // Otherwise keep it narrower.
      return typeof u === 'string' && (
        u.includes('api') ||
        u.includes('history') ||
        u.includes('review') ||
        u.includes('question') ||
        u.includes('earn') ||
        u.includes('comp') ||
        u.includes('payment')
      );
    };

    // Hook fetch
    const origFetch = window.fetch?.bind(window);
    if (origFetch) {
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const init = (args && args.length > 1 && args[1] && typeof args[1] === 'object') ? args[1] : null;
        const method = String(init?.method || (typeof args[0] !== 'string' ? (args[0]?.method || '') : '') || 'GET').toUpperCase();
        const reqHeaders = init?.headers || (typeof args[0] !== 'string' ? args[0]?.headers : null);
        const isGraphql = typeof url === 'string' && url.includes('/api/pensieve/graphql');
        let graphqlRequest = null;
        if (isGraphql && method === 'POST') {
          try {
            let bodyText = null;
            if (typeof init?.body === 'string') bodyText = init.body;
            // Some apps pass a Request object without init; try clone().
            if (!bodyText && typeof args[0] !== 'string' && args[0] && typeof args[0].clone === 'function') {
              try {
                const cloned = args[0].clone();
                bodyText = await cloned.text();
              } catch (_) {}
            }
            if (bodyText) {
              const bodyJson = (() => { try { return JSON.parse(bodyText); } catch (_) { return null; } })();
              const opName = String(bodyJson?.operationName || '').toLowerCase();
              const q = String(bodyJson?.query || '').toLowerCase();
              const inferredGqlType =
                (opName.includes('review') || q.includes('review')) ? 'review'
                  : ((opName.includes('question') || q.includes('question')) ? 'question' : 'unknown');
              graphqlRequest = {
                at: Date.now(),
                url,
                method,
                inferredType: inferredGqlType,
                body: bodyJson || { raw: bodyText },
              };
              // Best-effort: keep only a couple of headers if present.
              try {
                const picked = {};
                const getHdr = (k) => {
                  try {
                    if (!reqHeaders) return null;
                    if (typeof reqHeaders.get === 'function') return reqHeaders.get(k);
                    if (typeof reqHeaders === 'object') return reqHeaders[k] || reqHeaders[k.toLowerCase()];
                  } catch (_) {}
                  return null;
                };
                const ct = getHdr('content-type');
                if (ct) picked['content-type'] = ct;
                const csrf = getHdr('x-csrf-token');
                if (csrf) picked['x-csrf-token'] = csrf;
                graphqlRequest.headers = picked;
              } catch (_) {}
            }
          } catch (_) {}
        }

        const res = await origFetch(...args);
        try {
          if (interestingUrl(url)) {
            logDiscovery(`fetch ${res.status} ${url}`);
            // Save last-seen URL as a candidate endpoint.
            const d = loadDiscovery() || {};
            d.lastFetchUrl = url;
            d.lastFetchStatus = res.status;
            d.lastFetchAt = Date.now();
            d.enabled = true;
            d.endpoints = d.endpoints || {};
            d.candidates = Array.isArray(d.candidates) ? d.candidates : [];
            d.best = d.best || { reviews: 0, questions: 0 };
            d.graphql = d.graphql || {};
            if (graphqlRequest && graphqlRequest.body) {
              if (graphqlRequest.inferredType === 'review') d.graphql.reviews = graphqlRequest;
              else if (graphqlRequest.inferredType === 'question') d.graphql.questions = graphqlRequest;
              else d.graphql.last = graphqlRequest;
            }

            // Try parse payload (without consuming original).
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('application/json')) {
              try {
                const json = await res.clone().json();
                const urlLower = String(url).toLowerCase();
                const inferredType = urlLower.includes('review') ? 'review'
                  : (urlLower.includes('question') ? 'question' : undefined);
                const items = extractItemsFromAny(json, inferredType);
                const summary = summarizeItems(items);
                const keyHints = collectKeyHints(json);
                d.lastParsed = {
                  at: Date.now(),
                  url,
                  items: summary.itemsTotal,
                  reviewItems: summary.reviewItems,
                  questionItems: summary.questionItems,
                  countedReviews: summary.countedReviews,
                  countedQuestions: summary.countedQuestions,
                  sample: summary.sample,
                  keyHints,
                };
                d.candidates.unshift({
                  at: Date.now(),
                  url,
                  status: res.status,
                  items: summary.itemsTotal,
                  reviewItems: summary.reviewItems,
                  questionItems: summary.questionItems,
                });
                d.candidates = d.candidates.slice(0, 25);

                // Prefer endpoints that actually look like LISTS (avoid single-item responses).
                // Pick the endpoint with the highest count seen so far.
                if (summary.reviewItems >= 3 && summary.reviewItems >= (d.best.reviews || 0)) {
                  d.best.reviews = summary.reviewItems;
                  d.endpoints.reviews = url;
                } else if (inferredType === 'review' && !d.endpoints.reviews && !String(url).toLowerCase().includes('certifications')) {
                  // If the URL clearly looks like the reviews endpoint but there are too few/zero items,
                  // still record it so API pagination can work.
                  d.endpoints.reviews = url;
                }
                if (summary.questionItems >= 3 && summary.questionItems >= (d.best.questions || 0)) {
                  d.best.questions = summary.questionItems;
                  d.endpoints.questions = url;
                } else if (inferredType === 'question' && !d.endpoints.questions) {
                  d.endpoints.questions = url;
                }
              } catch (_) {}
            }
            saveDiscovery(d);
          }
        } catch (_) {}
        return res;
      };
    }

    // Hook XHR
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      function WrappedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
          _url = url;
          return origOpen.call(this, method, url, ...rest);
        };
        xhr.addEventListener('loadend', () => {
          try {
            if (interestingUrl(_url)) {
              logDiscovery(`xhr ${xhr.status} ${_url}`);
              const d = loadDiscovery() || {};
              d.lastXhrUrl = _url;
              d.lastXhrStatus = xhr.status;
              d.lastXhrAt = Date.now();
              d.enabled = true;
              d.endpoints = d.endpoints || {};
              d.candidates = Array.isArray(d.candidates) ? d.candidates : [];
              d.best = d.best || { reviews: 0, questions: 0 };
              const ct = String(xhr.getResponseHeader('content-type') || '').toLowerCase();
              if (ct.includes('application/json')) {
                try {
                  const json = JSON.parse(xhr.responseText || 'null');
                  const urlLower = String(_url).toLowerCase();
                  const inferredType = urlLower.includes('review') ? 'review'
                    : (urlLower.includes('question') ? 'question' : undefined);
                  const items = extractItemsFromAny(json, inferredType);
                  const summary = summarizeItems(items);
                  const keyHints = collectKeyHints(json);
                  d.lastParsed = {
                    at: Date.now(),
                    url: _url,
                    items: summary.itemsTotal,
                    reviewItems: summary.reviewItems,
                    questionItems: summary.questionItems,
                    countedReviews: summary.countedReviews,
                    countedQuestions: summary.countedQuestions,
                    sample: summary.sample,
                    keyHints,
                  };
                  d.candidates.unshift({
                    at: Date.now(),
                    url: _url,
                    status: xhr.status,
                    items: summary.itemsTotal,
                    reviewItems: summary.reviewItems,
                    questionItems: summary.questionItems,
                  });
                  d.candidates = d.candidates.slice(0, 25);

                  if (summary.reviewItems >= 3 && summary.reviewItems >= (d.best.reviews || 0)) {
                    d.best.reviews = summary.reviewItems;
                    d.endpoints.reviews = _url;
                  } else if (inferredType === 'review' && !d.endpoints.reviews && !String(_url).toLowerCase().includes('certifications')) {
                    d.endpoints.reviews = _url;
                  }
                  if (summary.questionItems >= 3 && summary.questionItems >= (d.best.questions || 0)) {
                    d.best.questions = summary.questionItems;
                    d.endpoints.questions = _url;
                  } else if (inferredType === 'question' && !d.endpoints.questions) {
                    d.endpoints.questions = _url;
                  }
                } catch (_) {}
              }
              saveDiscovery(d);
            }
          } catch (_) {}
        });
        return xhr;
      }
      window.XMLHttpRequest = WrappedXHR;
    }
  }

  function ensureHistoryIframe() {
    let iframe = document.getElementById(IFRAME_ID);
    if (iframe) return iframe;
    if (!document.body) return null;

    iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = `${window.location.origin}/queue/history`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = [
      'position: fixed',
      // Keep it off-screen but "full size" so responsive layouts + pagination controls render normally.
      // If this is tiny (e.g., 1px), the app can switch to mobile UI and hide controls.
      'left: -5000px',
      'top: 0',
      'width: 1400px',
      'height: 900px',
      'opacity: 0',
      'pointer-events: none',
      'border: 0',
    ].join(';');
    iframe.addEventListener('load', () => {
      // Kick a recompute as soon as iframe navigates/updates.
      scheduleRecompute(true);
      // Observe iframe DOM changes too (history data loads client-side).
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          const obs = new MutationObserver(() => scheduleRecompute());
          obs.observe(doc, { childList: true, subtree: true, characterData: true });
        }
      } catch (e) {
        lastBackgroundError = `Cannot read History iframe (blocked): ${String(e?.message || e)}`;
      }
    });
    document.body.appendChild(iframe);
    return iframe;
  }

  async function waitForHistoryDoc(timeoutMs = 30000) {
    // Preferred: hidden iframe (works if the site allows framing and content is same-origin readable).
    // We prefer this because it preserves the full SPA behavior (pagination, client-rendered data).
    const domOk = await waitForDomScaffold(timeoutMs);
    if (!domOk) {
      lastBackgroundError = 'Timed out waiting for the page DOM to initialize.';
      return null;
    }

    const iframe = ensureHistoryIframe();
    if (!iframe) {
      lastBackgroundError = 'Could not create History iframe (page body not available).';
      return null;
    }
    const started = Date.now();
    let forcedOnce = false;

    // Wait for iframe document to exist.
    while (Date.now() - started < timeoutMs) {
      let doc = null;
      let path = '';
      try {
        doc = iframe.contentDocument;
        path = iframe.contentWindow?.location?.pathname || '';
      } catch (e) {
        lastBackgroundError = `Cannot access History iframe (blocked): ${String(e?.message || e)}`;
        doc = null;
        path = '';
        break;
      }

      if (doc && doc.readyState !== 'loading') {
        // Some SPA states might redirect; re-navigate once if needed.
        if (!forcedOnce && path && !path.includes('/queue/history')) {
          forcedOnce = true;
          try {
            iframe.src = `${window.location.origin}/queue/history`;
          } catch (_) {}
        }

        // Wait until the client-rendered grid appears.
        const hasReviewsHeading = !!findHeadingByTextIn(doc, 'Reviews History');
        const hasGridCells = (doc.querySelectorAll('[role="gridcell"]').length || 0) > 0;
        if (hasReviewsHeading && hasGridCells) return doc;
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    // Last resort: fetch the History HTML with cookies and parse it.
    // This does NOT support pagination, but can still give a page-1 total.
    try {
      const resp = await fetch(`${window.location.origin}/queue/history`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!resp.ok) {
        lastBackgroundError = `History fetch failed: HTTP ${resp.status}`;
        return null;
      }
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const hasReviewsHeading = !!findHeadingByTextIn(doc, 'Reviews History');
      const hasGridCells = (doc.querySelectorAll('[role="gridcell"]').length || 0) > 0;
      if (hasReviewsHeading && hasGridCells) return doc;
      lastBackgroundError = 'History fetch succeeded, but no rows found in the HTML (likely rendered client-side).';
      return null;
    } catch (e) {
      lastBackgroundError = `History fetch error: ${String(e?.message || e)}`;
      return null;
    }
  }

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    if (!hasDomScaffold()) return null;

    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.innerHTML = `
      <div class="tm-inner">
        <div class="tm-row">
          <div class="tm-inline">
            <span class="tm-pill"><span class="tm-k">R</span> <span class="tm-reviews">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-pill"><span class="tm-k">Q</span> <span class="tm-questions">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-pill tm-total"><span class="tm-k">T</span> <span class="tm-total-value">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-status">OK</span>
          </div>
          <button type="button" class="tm-btn tm-toggle" title="Toggle details">i</button>
        </div>
        <div class="tm-details" hidden>
          <div class="tm-meta tm-meta-1"></div>
          <div class="tm-controls">
            <label class="tm-label">Date <input type="date" class="tm-date" /></label>
            <button type="button" class="tm-btn tm-today" title="Set date to today">Today</button>
          </div>
          <div class="tm-actions">
            <button type="button" class="tm-btn tm-recalc">Recalculate</button>
            <button type="button" class="tm-btn tm-discover" title="Record History API endpoint">Enable Discovery</button>
          </div>
        </div>
      </div>
    `.trim();

    const style = document.createElement('style');
    style.textContent = `
      #${BAR_ID} {
        position: fixed;
        right: ${DEFAULT_RIGHT_PX}px;
        bottom: ${DEFAULT_BOTTOM_PX}px;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        pointer-events: none;
      }
      #${BAR_ID} .tm-inner {
        pointer-events: auto;
        width: max-content;
        max-width: 460px;
        margin: 0;
        background: rgba(20, 24, 30, 0.92);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 999px;
        padding: 4px 6px;
        box-shadow: 0 10px 22px rgba(0,0,0,0.26);
        backdrop-filter: blur(8px);
      }
      #${BAR_ID} .tm-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${BAR_ID} .tm-inline {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        font-size: 14px;
        overflow: hidden;
      }
      #${BAR_ID} .tm-pill {
        white-space: nowrap;
      }
      #${BAR_ID} .tm-total {
        font-weight: 700;
      }
      #${BAR_ID} .tm-sep { opacity: 0.6; }
      #${BAR_ID} .tm-k {
        opacity: 0.75;
        font-weight: 700;
        letter-spacing: 0.2px;
      }
      #${BAR_ID} .tm-status {
        opacity: 0.8;
        font-weight: 600;
      }
      #${BAR_ID} .tm-meta {
        font-size: 14px;
        opacity: 0.75;
        margin-top: 4px;
      }
      #${BAR_ID} .tm-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 6px;
        gap: 6px;
      }
      #${BAR_ID} .tm-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 6px;
      }
      #${BAR_ID} .tm-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        opacity: 0.9;
      }
      #${BAR_ID} .tm-date {
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.25);
        background: rgba(255,255,255,0.10);
        color: #fff;
      }
      #${BAR_ID} .tm-date::-webkit-calendar-picker-indicator { filter: invert(1); opacity: 0.85; }
      #${BAR_ID} .tm-btn {
        font-size: 14px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.25);
        background: rgba(255,255,255,0.10);
        color: #fff;
        cursor: pointer;
      }
      #${BAR_ID} .tm-btn:hover { background: rgba(255,255,255,0.16); }
    `.trim();

    document.head.appendChild(style);
    document.body.appendChild(bar);

    const details = bar.querySelector('.tm-details');
    const toggleBtn = bar.querySelector('.tm-toggle');
    const setDetails = (open) => {
      if (!details) return;
      details.hidden = !open;
      try { localStorage.setItem(DETAILS_KEY, open ? '1' : '0'); } catch (_) {}
    };
    const initialOpen = (() => {
      try { return localStorage.getItem(DETAILS_KEY) === '1'; } catch (_) { return false; }
    })();
    setDetails(initialOpen);

    toggleBtn?.addEventListener('click', () => setDetails(!!details?.hidden));
    bar.querySelector('.tm-recalc')?.addEventListener('click', () => recomputeAndRender({ force: true }));
    const dateInput = bar.querySelector('.tm-date');
    const applyDateToUi = () => {
      const parts = getTargetDayParts();
      const key = partsToDayKey(parts);
      if (dateInput && dateInput.value !== key) dateInput.value = key;
    };
    applyDateToUi();
    dateInput?.addEventListener('change', () => {
      const parts = parseDayKeyToParts(dateInput.value);
      if (parts) setTargetDayParts(parts);
      recomputeAndRender({ force: true });
    });
    bar.querySelector('.tm-today')?.addEventListener('click', () => {
      setTargetDayParts(getTodayParts(TODAY_TIME_ZONE));
      applyDateToUi();
      recomputeAndRender({ force: true });
    });
    bar.querySelector('.tm-discover')?.addEventListener('click', () => {
      installNetworkDiscoveryHooks();
      const d = loadDiscovery() || {};
      d.enabled = true;
      d.endpoints = d.endpoints || {};
      saveDiscovery(d);
      lastBackgroundError = 'Discovery enabled. Open the History tab once so the script can capture the API requests, then come back here.';
      lastStatus = 'loading';
      scheduleRecompute(true);
    });

    // Position it just above Udacity's bottom-right "Auto Refresh" box (if present).
    const position = () => positionBar(bar);
    position();
    window.addEventListener('resize', position);

    return bar;
  }

  function findAutoRefreshBox() {
    // Robust approach:
    // 1) find ANY element containing "Auto Refresh"
    // 2) walk up its ancestors to find the fixed/sticky container near bottom-right.
    const needleRe = /Auto\s+Refresh/i;
    const all = Array.from(document.querySelectorAll('body *'));

    let best = null;
    let bestScore = -Infinity;

    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!t || !needleRe.test(t)) continue;

      // Prefer a fixed/sticky ancestor near bottom-right.
      let cur = el;
      for (let i = 0; i < 10 && cur; i += 1) {
        const rect = cur.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          cur = cur.parentElement;
          continue;
        }

        const style = window.getComputedStyle(cur);
        const pos = style?.position || '';
        const isFixedLike = pos === 'fixed' || pos === 'sticky';
        const nearBottom = rect.bottom > window.innerHeight - 80;
        const nearRight = rect.right > window.innerWidth - 80;

        // If we found a plausible widget container, return immediately.
        if (isFixedLike && nearBottom && nearRight && rect.width >= 220 && rect.height >= 26) {
          return cur;
        }

        // Otherwise track the best-looking candidate.
        const areaScore = (rect.width * rect.height) / 1000;
        const score =
          (isFixedLike ? 1000 : 0) +
          (nearBottom ? 250 : 0) +
          (nearRight ? 250 : 0) +
          areaScore;
        if (score > bestScore) {
          bestScore = score;
          best = cur;
        }

        cur = cur.parentElement;
      }
    }

    return best;
  }

  function positionBar(bar) {
    try {
      const anchor = findAutoRefreshBox();
      if (!anchor) {
        bar.style.right = `${DEFAULT_RIGHT_PX}px`;
        // If the widget exists but we couldn't detect it, this avoids overlap anyway.
        bar.style.bottom = `${SAFE_FALLBACK_CLEARANCE_PX}px`;
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const right = Math.max(DEFAULT_RIGHT_PX, window.innerWidth - rect.right);
      const bottom = Math.max(DEFAULT_BOTTOM_PX, window.innerHeight - rect.top + ANCHOR_GAP_PX);
      bar.style.right = `${Math.round(right)}px`;
      bar.style.bottom = `${Math.round(bottom)}px`;
    } catch (_) {
      // fall back to default positioning
      bar.style.right = `${DEFAULT_RIGHT_PX}px`;
      bar.style.bottom = `${SAFE_FALLBACK_CLEARANCE_PX}px`;
    }
  }

  function render({ reviews, questions, note }) {
    const bar = ensureBar();
    if (!bar) return;
    const target = getTargetDayParts();
    const dayKey = partsToDayKey(target);
    const locked = loadBestLock(dayKey);
    const incomingPayload = {
      reviews: reviews.sum || 0,
      questions: questions.sum || 0,
      countedReviews: reviews.rowsCounted || 0,
      countedQuestions: questions.rowsCounted || 0,
    };
    // Never visually regress below the best known total for the selected day.
    if (locked && !shouldOverwriteDayCache(locked, incomingPayload)) {
      reviews = {
        ...reviews,
        sum: locked.reviews || 0,
        rowsCounted: locked.countedReviews || reviews.rowsCounted || 0,
        rowsSeen: Math.max(reviews.rowsSeen || 0, locked.countedReviews || 0),
        found: true,
      };
      questions = {
        ...questions,
        sum: locked.questions || 0,
        rowsCounted: locked.countedQuestions || questions.rowsCounted || 0,
        rowsSeen: Math.max(questions.rowsSeen || 0, locked.countedQuestions || 0),
        found: true,
      };
      note = note ? `${note} (holding best total)` : 'Holding best total from cache.';
    }

    const total = reviews.sum + questions.sum;

    const setText = (sel, txt) => {
      const el = bar.querySelector(sel);
      if (el && el.textContent !== txt) el.textContent = txt;
    };

    const normalizeCount = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const reviewsCount = normalizeCount(reviews.rowsCounted);
    const questionsCount = normalizeCount(questions.rowsCounted);
    const totalCount = reviewsCount + questionsCount;
    const formatMoneyWithCount = (amount, count) => `${formatMoney(amount)} (${count})`;

    const reviewsText = formatMoneyWithCount(reviews.sum, reviewsCount);
    const questionsText = formatMoneyWithCount(questions.sum, questionsCount);
    const totalText = formatMoneyWithCount(total, totalCount);

    const tz = TODAY_TIME_ZONE ? ` (${TODAY_TIME_ZONE})` : '';
    const meta = `Counting rows completed on: ${partsToDayKey(target)}${tz}.`;
    const paging = lastPagingInfo ? ` ${lastPagingInfo}` : '';
    const failure = lastApiFailure ? ` API: ${lastApiFailure}` : '';
    const details = reviews.found || questions.found
      ? `Reviews: ${reviews.rowsCounted}/${reviews.rowsSeen} rows, Questions: ${questions.rowsCounted}/${questions.rowsSeen} rows.${paging}${failure}`
      : `${note || lastBackgroundError || 'Open the History tab to compute today’s total.'}${paging}${failure}`;

    const metaText = `${meta} ${details}`;

    // Avoid needless DOM writes (prevents flicker + reduces mutation loops).
    const statusText =
      lastStatus === 'loading' ? '…' :
      lastStatus === 'error' ? 'ERR' :
      'OK';

    const signature = [
      reviewsText,
      questionsText,
      totalText,
      statusText,
      metaText,
    ].join('|');
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    setText('.tm-reviews', reviewsText);
    setText('.tm-questions', questionsText);
    setText('.tm-total-value', totalText);
    setText('.tm-status', statusText);
    const d = loadDiscovery();
    const endpointReviewsRaw = d?.endpoints?.reviews ? String(d.endpoints.reviews) : '';
    const endpointQuestionsRaw = d?.endpoints?.questions ? String(d.endpoints.questions) : '';
    const endpointReviewsUsable = isUsableApiEndpointUrl(endpointReviewsRaw);
    const endpointQuestionsUsable = isUsableApiEndpointUrl(endpointQuestionsRaw);
    const endpoints = d?.endpoints
      ? `Endpoints: reviews=${endpointReviewsRaw ? (endpointReviewsUsable ? 'yes' : 'ignored') : 'no'}, questions=${endpointQuestionsRaw ? (endpointQuestionsUsable ? 'yes' : 'ignored') : 'no'}.` +
        (endpointReviewsRaw ? ` reviewsUrl=${endpointReviewsRaw}` : '') +
        (endpointQuestionsRaw ? ` questionsUrl=${endpointQuestionsRaw}` : '')
      : 'Endpoints: none.';
    const parsed = d?.lastParsed
      ? ` Last parsed: ${new Date(d.lastParsed.at).toLocaleString()} (items=${d.lastParsed.items || 0}, reviewItems=${d.lastParsed.reviewItems || 0}, questionItems=${d.lastParsed.questionItems || 0}, selected day: ${d.lastParsed.countedReviews || 0} reviews / ${d.lastParsed.countedQuestions || 0} questions, url=${d.lastParsed.url || ''}, keyHints=${Array.isArray(d.lastParsed.keyHints) ? d.lastParsed.keyHints.join(',') : ''}).`
      : '';
    const lockMeta = locked ? ` BestLock=${formatMoney((locked.reviews || 0) + (locked.questions || 0))}.` : ' BestLock=none.';
    const src = ` Source: ${lastDataSource}.`;
    setText('.tm-meta-1', `${metaText} ${endpoints}${parsed}${lockMeta}${src}`);

    // Keep the bar aligned above the bottom-right box as the page changes.
    positionBar(bar);
  }

  let historyDocPromise = null;
  let historyDoc = null;
  let lastPagingInfo = '';

  function pickFirstDefined(...vals) {
    for (const v of vals) if (v != null) return v;
    return null;
  }

  function toAbsoluteUrlMaybe(u, base) {
    if (!u || typeof u !== 'string') return null;
    try {
      return new URL(u, base || window.location.origin).toString();
    } catch (_) {
      return null;
    }
  }

  function looksLikeUrlishString(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (!t) return false;
    if (t.startsWith('http://') || t.startsWith('https://')) return true;
    if (t.startsWith('/')) return true;
    return false;
  }

  function findNextUrlInPayload(payload, baseUrl) {
    // Common REST pagination shapes.
    const nextCandidate = pickFirstDefined(
      payload?.next,
      payload?.links?.next,
      payload?._links?.next?.href,
      payload?.pagination?.next,
      payload?.pagination?.nextUrl,
      payload?.pagination?.next_url,
      payload?.meta?.next,
      payload?.meta?.nextUrl,
      payload?.meta?.next_url
    );
    if (typeof nextCandidate === 'string') return toAbsoluteUrlMaybe(nextCandidate, baseUrl);
    if (nextCandidate && typeof nextCandidate === 'object' && typeof nextCandidate.href === 'string') {
      return toAbsoluteUrlMaybe(nextCandidate.href, baseUrl);
    }

    // Fallback: deep-walk for any "next*" link-like field.
    // We keep it conservative: key must include "next", value must look URL-ish.
    const stack = [payload];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      for (const k of Object.keys(cur)) {
        const v = cur[k];
        if (k && typeof k === 'string' && k.toLowerCase().includes('next')) {
          if (typeof v === 'string' && looksLikeUrlishString(v)) {
            return toAbsoluteUrlMaybe(v, baseUrl);
          }
          if (v && typeof v === 'object') {
            const href = typeof v.href === 'string' ? v.href : null;
            const url = typeof v.url === 'string' ? v.url : null;
            const link = typeof v.link === 'string' ? v.link : null;
            const s = href || url || link;
            if (s && looksLikeUrlishString(s)) return toAbsoluteUrlMaybe(s, baseUrl);
          }
        }
        stack.push(v);
      }
    }
    return null;
  }

  function findCursorPageInfo(payload) {
    // Looks for GraphQL-like pageInfo { hasNextPage, endCursor } anywhere in the payload.
    const stack = [payload];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      if (cur.pageInfo && typeof cur.pageInfo === 'object') {
        const pi = cur.pageInfo;
        const hasNext = typeof pi.hasNextPage === 'boolean' ? pi.hasNextPage : null;
        const endCursor = typeof pi.endCursor === 'string' ? pi.endCursor : null;
        if (endCursor) return { hasNext, endCursor };
      }
      const hasNext = typeof cur.hasNextPage === 'boolean' ? cur.hasNextPage : null;
      const endCursor = typeof cur.endCursor === 'string' ? cur.endCursor : null;
      const nextCursor = typeof cur.nextCursor === 'string' ? cur.nextCursor : null;
      const next_cursor = typeof cur.next_cursor === 'string' ? cur.next_cursor : null;
      if (endCursor || nextCursor || next_cursor) {
        return { hasNext, endCursor: endCursor || nextCursor || next_cursor };
      }
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
    return null;
  }

  function cloneJson(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return null; }
  }

  function updateGraphqlCursorVars(body, endCursor) {
    if (!body || typeof body !== 'object' || !endCursor) return body;
    const b = cloneJson(body) || body;
    b.variables = (b.variables && typeof b.variables === 'object') ? b.variables : {};
    const keys = ['after', 'cursor', 'pageCursor', 'page_cursor', 'endCursor', 'end_cursor', 'starting_after', 'startingAfter'];
    let changed = false;
    for (const k of keys) {
      if (k in b.variables) {
        b.variables[k] = endCursor;
        changed = true;
      }
    }
    if (!changed) {
      // Add a common cursor var if none exists.
      b.variables.after = endCursor;
    }
    return b;
  }

  async function fetchGraphqlItemsForDayPaginated({ request, fallbackType, targetDayParts }) {
    const MAX_PAGES = 60;
    const SLEEP_MS = 150;
    const target = targetDayParts || getTargetDayParts();
    const url = request?.url;
    const baseBody = request?.body;
    if (!url || !baseBody || typeof baseBody !== 'object') throw new Error('No GraphQL request captured yet');

    let body = cloneJson(baseBody) || baseBody;
    let page = 0;
    const matched = [];

    while (page < MAX_PAGES) {
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...(request.headers || {}),
        },
        body: JSON.stringify(body),
      });
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
      if (!ct.includes('application/json')) throw new Error('GraphQL not JSON');
      const json = await resp.json();

      const items = extractItemsFromAny(json, fallbackType);
      for (const it of items) {
        const parts = getPartsForDate(it.completedDate, TODAY_TIME_ZONE);
        if (sameYMD(parts, target)) matched.push(it);
      }

      const cursorInfo = findCursorPageInfo(json);
      if (!cursorInfo?.endCursor || cursorInfo.hasNext === false) break;
      body = updateGraphqlCursorVars(body, cursorInfo.endCursor);

      page += 1;
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }

    return { items: matched, pagesFetched: page + 1 };
  }

  function parseLinkHeaderForRelNext(linkHeader, baseUrl) {
    // RFC 5988-ish: <url>; rel="next", <url2>; rel="prev"
    if (!linkHeader || typeof linkHeader !== 'string') return null;
    const parts = linkHeader.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const m = p.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
      if (m && m[1]) return toAbsoluteUrlMaybe(m[1], baseUrl);
    }
    return null;
  }

  function findNextUrlInHeaders(headers, baseUrl) {
    if (!headers) return null;
    try {
      const link = headers.get?.('link') || headers.get?.('Link') || '';
      const fromLink = parseLinkHeaderForRelNext(link, baseUrl);
      if (fromLink) return fromLink;

      const candidates = [
        headers.get?.('x-next-page'),
        headers.get?.('X-Next-Page'),
        headers.get?.('x-next'),
        headers.get?.('X-Next'),
        headers.get?.('x-next-url'),
        headers.get?.('X-Next-Url'),
      ].filter(Boolean);
      for (const c of candidates) {
        if (typeof c === 'string' && looksLikeUrlishString(c)) return toAbsoluteUrlMaybe(c, baseUrl);
      }
    } catch (_) {}
    return null;
  }

  function deriveNextUrlFromQueryPaging(currentUrl, pageIndex, cursorInfo) {
    // Try to increment ?page=, or bump ?offset= by ?limit=, or set a cursor param.
    let u;
    try {
      u = new URL(currentUrl, window.location.origin);
    } catch (_) {
      return null;
    }
    const sp = u.searchParams;

    // Cursor-based (when URL already has a cursor/after param).
    if (cursorInfo?.endCursor) {
      const cursorKeys = ['cursor', 'after', 'starting_after', 'startingAfter', 'page_cursor', 'pageCursor', 'endCursor'];
      for (const k of cursorKeys) {
        if (sp.has(k)) {
          sp.set(k, cursorInfo.endCursor);
          return u.toString();
        }
      }
      // If we have cursor info but no cursor param in the URL, try the most common one.
      // Most servers ignore unknown query params, so this is usually safe.
      if (cursorInfo.hasNext !== false) {
        sp.set('after', cursorInfo.endCursor);
        sp.set('cursor', cursorInfo.endCursor);
        sp.set('pageCursor', cursorInfo.endCursor);
        sp.set('page_cursor', cursorInfo.endCursor);
        return u.toString();
      }
    }

    // Page-based.
    if (sp.has('page')) {
      const cur = Number(sp.get('page'));
      if (Number.isFinite(cur)) {
        sp.set('page', String(cur + 1));
        return u.toString();
      }
      sp.set('page', String(pageIndex + 2)); // fall back if page isn't numeric
      return u.toString();
    }
    if (sp.has('pageNumber')) {
      const cur = Number(sp.get('pageNumber'));
      if (Number.isFinite(cur)) {
        sp.set('pageNumber', String(cur + 1));
        return u.toString();
      }
    }
    if (sp.has('page[number]')) {
      const cur = Number(sp.get('page[number]'));
      if (Number.isFinite(cur)) {
        sp.set('page[number]', String(cur + 1));
        return u.toString();
      }
    }

    // Offset/limit-based.
    if (sp.has('offset')) {
      const offset = Number(sp.get('offset'));
      const limit = Number(sp.get('limit') || sp.get('per_page') || sp.get('perPage') || sp.get('pageSize') || sp.get('page_size'));
      if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
        sp.set('offset', String(offset + limit));
        return u.toString();
      }
      // If no limit, at least try moving by 50.
      if (Number.isFinite(offset)) {
        sp.set('offset', String(offset + 50));
        if (!sp.has('limit')) sp.set('limit', '50');
        return u.toString();
      }
    }

    return null;
  }

  async function fetchItemsForDayPaginated({ url, type, targetDayParts }) {
    const MAX_PAGES = 60;
    const SLEEP_MS = 150;
    const target = targetDayParts || getTargetDayParts();

    let curUrl = url;
    let page = 0;
    const seenUrls = new Set();
    const matched = [];
    let sawTarget = false;
    let lastPageHadTarget = false;
    let stoppedBecauseNoNext = false;

    async function fetchJsonPage(pageUrl, allowSoftFail) {
      try {
        const resp = await fetch(pageUrl, { credentials: 'include', cache: 'no-store' });
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!resp.ok) {
          if (allowSoftFail) return null;
          throw new Error(`API HTTP ${resp.status} for ${pageUrl}`);
        }
        if (!ct.includes('application/json')) {
          if (allowSoftFail) return null;
          throw new Error(`API not JSON for ${pageUrl}`);
        }
        const json = await resp.json();
        const nextFromHeaders = findNextUrlInHeaders(resp.headers, pageUrl);
        return { json, nextFromHeaders };
      } catch (e) {
        if (allowSoftFail) return null;
        throw e;
      }
    }

    while (curUrl && page < MAX_PAGES) {
      if (seenUrls.has(curUrl)) break;
      seenUrls.add(curUrl);

      const pageResp = await fetchJsonPage(curUrl, page > 0 /* allowSoftFail */);
      if (!pageResp) break;
      const { json, nextFromHeaders } = pageResp;
      const items = extractItemsFromAny(json, type);
      if (!items.length) break;

      let maxParts = null;
      lastPageHadTarget = false;
      for (const it of items) {
        const parts = getPartsForDate(it.completedDate, TODAY_TIME_ZONE);
        if (!maxParts || compareYMD(parts, maxParts) > 0) maxParts = parts;
        if (sameYMD(parts, target)) {
          matched.push(it);
          sawTarget = true;
          lastPageHadTarget = true;
        }
      }

      // Stop only when the entire page is older than the target day.
      // (Some APIs interleave older items on a page, so we must NOT stop just because the page contains any older rows.)
      if (maxParts && compareYMD(maxParts, target) < 0) {
        break;
      }

      const cursorInfo = findCursorPageInfo(json);
      const nextFromPayload = findNextUrlInPayload(json, curUrl);
      const nextFromQuery = deriveNextUrlFromQueryPaging(curUrl, page, cursorInfo);
      const candidates = [nextFromHeaders, nextFromPayload, nextFromQuery].filter(Boolean);
      // If the page had target rows but we can't find a next URL, don't pretend we're complete.
      // We'll stop, but the UI will indicate pagination was incomplete.
      const nextUrl = candidates.find((u) => u && u !== curUrl) || null;
      if (!nextUrl) {
        stoppedBecauseNoNext = true;
        break;
      }

      curUrl = nextUrl;
      page += 1;
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }

    return { items: matched, pagesFetched: page + 1, sawTarget, lastPageHadTarget, stoppedBecauseNoNext };
  }

  function loadDayCache(cache, dayKey) {
    if (!cache || typeof cache !== 'object') return null;
    const byDayVal = (cache.byDay && typeof cache.byDay === 'object' && cache.byDay[dayKey]) ? cache.byDay[dayKey] : null;
    const bestVal = (cache.bestByDay && typeof cache.bestByDay === 'object' && cache.bestByDay[dayKey]) ? cache.bestByDay[dayKey] : null;
    const lockVal = loadBestLock(dayKey);
    if (byDayVal || bestVal || lockVal) {
      let winner = byDayVal || null;
      if (!winner || shouldOverwriteDayCache(winner, bestVal)) winner = bestVal || winner;
      if (!winner || shouldOverwriteDayCache(winner, lockVal)) winner = lockVal || winner;
      return winner;
    }
    // Legacy format: single "today" payload
    if (cache.today && sameYMD(cache.today, parseDayKeyToParts(dayKey))) {
      return {
        reviews: cache.reviews,
        questions: cache.questions,
        countedReviews: cache.countedReviews,
        countedQuestions: cache.countedQuestions,
      };
    }
    return null;
  }

  function saveDayCache(dayKey, payload) {
    const existing = loadCache() || {};
    const byDay = (existing.byDay && typeof existing.byDay === 'object') ? existing.byDay : {};
    const bestByDay = (existing.bestByDay && typeof existing.bestByDay === 'object') ? existing.bestByDay : {};
    byDay[dayKey] = {
      reviews: payload.reviews || 0,
      questions: payload.questions || 0,
      countedReviews: payload.countedReviews || 0,
      countedQuestions: payload.countedQuestions || 0,
      at: Date.now(),
    };
    const prevBest = bestByDay[dayKey] || null;
    const nextVal = byDay[dayKey];
    bestByDay[dayKey] = shouldOverwriteDayCache(prevBest, nextVal) ? nextVal : prevBest;
    saveBestLock(dayKey, nextVal);
    // Keep the object bounded.
    const keys = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));
    for (const k of keys.slice(31)) delete byDay[k];
    const bestKeys = Object.keys(bestByDay).sort((a, b) => (a < b ? 1 : -1));
    for (const k of bestKeys.slice(31)) delete bestByDay[k];
    saveCache({ ...existing, at: Date.now(), byDay, bestByDay });
  }

  function shouldOverwriteDayCache(existingDay, nextDay) {
    // Prevent overwriting a "fuller" day total with a partial one.
    if (!nextDay) return false;
    if (!existingDay) return true;
    const exCount = (existingDay.countedReviews || 0) + (existingDay.countedQuestions || 0);
    const nxCount = (nextDay.countedReviews || 0) + (nextDay.countedQuestions || 0);
    const exSum = (existingDay.reviews || 0) + (existingDay.questions || 0);
    const nxSum = (nextDay.reviews || 0) + (nextDay.questions || 0);
    // If totals differ, trust the larger total. This protects multi-page history totals.
    if (nxSum > exSum + 0.0001) return true;
    if (nxSum + 0.0001 < exSum) return false;
    // If totals tie, use counts as tiebreaker.
    if (nxCount > exCount) return true;
    if (nxCount < exCount) return false;
    return true;
  }

  async function recomputeAndRender({ force = false } = {}) {
    if (recomputeInFlight) {
      recomputeQueued = true;
      return;
    }
    recomputeInFlight = true;
    try {
      const discovery = loadDiscovery();
      const cache = loadCache();
      const targetDay = getTargetDayParts();
      const dayKey = partsToDayKey(targetDay);
      const dayCache = loadDayCache(cache, dayKey);
      if (dayCache) saveBestLock(dayKey, dayCache);

      // On the History page, ALWAYS compute from the History UI (and paginate it).
      // This prevents a broken/false-positive API endpoint from overriding correct History totals.
      if (isHistoryRoute()) {
        installNetworkDiscoveryHooks();
        historyDoc = document;
        historyDocPromise = null;

        const reviews = await computeSectionSumPaginatedIn(historyDoc, {
          startHeadingText: 'Reviews History',
          endHeadingText: 'Question History',
          rowTerminatorRe: /^View review$/i,
        });
        const questions = await computeSectionSumPaginatedIn(historyDoc, {
          startHeadingText: 'Question History',
          endHeadingText: null,
          rowTerminatorRe: /^View question$/i,
        });

        lastStatus = (reviews.found || questions.found) ? 'ready' : 'error';
        if (lastStatus === 'error' && !lastBackgroundError) {
          lastBackgroundError = 'History data loaded, but could not locate expected rows.';
        }
        if (lastStatus === 'ready') {
          lastDataSource = 'history';
          const rp = reviews?.pages || 1;
          const qp = questions?.pages || 1;
          lastPagingInfo = `Paged History: R ${rp}p, Q ${qp}p.`;
          lastApiFailure = '';
          saveDayCache(dayKey, {
            reviews: reviews.sum,
            questions: questions.sum,
            countedReviews: reviews.rowsCounted,
            countedQuestions: questions.rowsCounted,
          });
        }
        render({ reviews, questions, note: '' });
        return;
      }

      // Best path (no History visit needed *after initial discovery*):
      // call the discovered API endpoints directly and compute totals.
      // Important: allow API mode even on /queue/history, and even if only one endpoint is known.
      // This avoids "page 1 only" History DOM limitations.
      if (hasAnyApiEndpoint(discovery) || discovery?.graphql?.reviews || discovery?.graphql?.questions || discovery?.graphql?.last) {
        try {
          if (!force && Date.now() - lastApiFetchAt < 15_000) return; // throttle
          lastApiFetchAt = Date.now();
          lastStatus = 'loading';
          lastDataSource = 'api';
          lastPagingInfo = '';
          lastApiFailure = '';
          render({
            reviews: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
            questions: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
            note: 'Loading totals from API…',
          });

          const urls = [
            isUsableApiEndpointUrl(discovery.endpoints.reviews) ? { type: 'review', url: discovery.endpoints.reviews } : null,
            isUsableApiEndpointUrl(discovery.endpoints.questions) ? { type: 'question', url: discovery.endpoints.questions } : null,
          ].filter(Boolean);

          let items = [];
          let reviewPages = 0;
          let questionPages = 0;
          let incomplete = false;
          for (const entry of urls) {
            const paged = await fetchItemsForDayPaginated({ url: entry.url, type: entry.type, targetDayParts: targetDay });
            items = items.concat(paged.items);
            if (entry.type === 'review') reviewPages = paged.pagesFetched || 0;
            if (entry.type === 'question') questionPages = paged.pagesFetched || 0;
            if (paged.stoppedBecauseNoNext && paged.lastPageHadTarget) incomplete = true;
          }

          // If REST endpoints are unusable/missing, try captured GraphQL from History page.
          if (!urls.length) {
            const gql = discovery?.graphql || {};
            if (gql.reviews) {
              const paged = await fetchGraphqlItemsForDayPaginated({ request: gql.reviews, fallbackType: 'review', targetDayParts: targetDay });
              items = items.concat(paged.items);
              reviewPages = paged.pagesFetched || 0;
            }
            if (gql.questions) {
              const paged = await fetchGraphqlItemsForDayPaginated({ request: gql.questions, fallbackType: 'question', targetDayParts: targetDay });
              items = items.concat(paged.items);
              questionPages = paged.pagesFetched || 0;
            }
            if (!gql.reviews && !gql.questions && gql.last) {
              const paged = await fetchGraphqlItemsForDayPaginated({ request: gql.last, fallbackType: undefined, targetDayParts: targetDay });
              items = items.concat(paged.items);
            }
          }

          const totals = computeTotalsFromItems(items, targetDay);
          const apiCounts = (totals.countedReviews || 0) + (totals.countedQuestions || 0);

          // If API parsing yielded 0 items for the selected day, do NOT show $0.00 as a final answer.
          // Fall back to History scanning (which can paginate the UI) or background History fetch.
          if (apiCounts === 0) {
            lastStatus = 'error';
            lastDataSource = 'api';
            lastPagingInfo = `Paged API: R ${reviewPages || 1}p, Q ${questionPages || 1}p${incomplete ? ' (may be missing more—no next link found)' : ''}.`;
            lastBackgroundError = 'API returned 0 parsed items for the selected day; falling back to History scan.';
            lastApiFailure = '0 parsed items';
            throw new Error('API returned 0 parsed items');
          }

          lastStatus = 'ready';
          lastBackgroundError = '';
          lastDataSource = 'api';
          lastPagingInfo = `Paged API: R ${reviewPages || 1}p, Q ${questionPages || 1}p${incomplete ? ' (may be missing more—no next link found)' : ''}.`;

          const cacheCounts = dayCache
            ? ((dayCache.countedReviews || 0) + (dayCache.countedQuestions || 0))
            : 0;

          // If API returns 0 items for the selected day but cache has data:
          // - on Overview: show cache (fast, avoids flashing 0)
          // - on History: fall through and compute by paginating the History UI (handles multi-page days)
          if (apiCounts === 0 && cacheCounts > 0 && !isHistoryRoute() && !force) {
            lastStatus = 'ready';
            lastDataSource = 'cache';
            render({
              reviews: { sum: dayCache.reviews || 0, found: true, rowsCounted: dayCache.countedReviews || 0, rowsSeen: dayCache.countedReviews || 0 },
              questions: { sum: dayCache.questions || 0, found: true, rowsCounted: dayCache.countedQuestions || 0, rowsSeen: dayCache.countedQuestions || 0 },
              note: 'API returned 0 for today; showing cached totals.',
            });
            return;
          }

          // Only overwrite cache when it improves/extends what we already have.
          if (shouldOverwriteDayCache(dayCache, totals)) {
            saveDayCache(dayKey, totals);
          }
          saveBestLock(dayKey, totals);
          render({
            reviews: { sum: totals.reviews, found: true, rowsCounted: totals.countedReviews, rowsSeen: totals.countedReviews },
            questions: { sum: totals.questions, found: true, rowsCounted: totals.countedQuestions, rowsSeen: totals.countedQuestions },
            note: (hasApiEndpoint(discovery, 'question') ? '' : 'Questions endpoint not discovered yet; questions total may be incomplete.'),
          });
          return;
        } catch (e) {
          lastStatus = 'error';
          lastBackgroundError = `API mode failed: ${String(e?.message || e)}`;
          lastPagingInfo = '';
          lastApiFailure = String(e?.message || e);
          // fall through to other methods
        }
      }

      // If API isn't usable yet but we have cache, show cache immediately,
      // then continue and try to compute from History in the background (so multi-page days get accumulated).
      if (!hasAnyApiEndpoint(discovery) && dayCache && !force) {
        lastStatus = 'loading';
        lastDataSource = 'cache';
        lastBackgroundError = '';
        lastPagingInfo = '';
        lastApiFailure = '';
        render({
          reviews: { sum: dayCache.reviews || 0, found: true, rowsCounted: dayCache.countedReviews || 0, rowsSeen: dayCache.countedReviews || 0 },
          questions: { sum: dayCache.questions || 0, found: true, rowsCounted: dayCache.countedQuestions || 0, rowsSeen: dayCache.countedQuestions || 0 },
          note: 'Updating from History…',
        });
        // fall through (do not return)
      }

      // Prefer computing directly from the History page if we're on it.
      if (isHistoryRoute()) {
        // Ensure hooks are installed before/while History loads.
        installNetworkDiscoveryHooks();
        // On the History page, prefer the *live* document.
        // This avoids iframe rendering differences and ensures the paginator is acting on the same UI you see.
        historyDoc = document;
        historyDocPromise = null;
      } else if (!historyDoc || force) {
        if (!historyDocPromise || force) historyDocPromise = waitForHistoryDoc();
        historyDoc = await historyDocPromise;
      }

      if (!historyDoc) {
        // If we're on History and couldn't access it, don't silently show cache as "truth".
        // Otherwise it looks like paging isn't adding anything.
        if (dayCache && !isHistoryRoute()) {
          lastStatus = 'ready';
          lastDataSource = 'cache';
          lastBackgroundError = '';
          lastPagingInfo = '';
          render({
            reviews: { sum: dayCache.reviews || 0, found: true, rowsCounted: dayCache.countedReviews || 0, rowsSeen: dayCache.countedReviews || 0 },
            questions: { sum: dayCache.questions || 0, found: true, rowsCounted: dayCache.countedQuestions || 0, rowsSeen: dayCache.countedQuestions || 0 },
            note: '',
          });
          return;
        }
        lastStatus = lastBackgroundError ? 'error' : 'loading';
        lastDataSource = 'none';
        lastPagingInfo = '';
        render({
          reviews: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
          questions: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
          note: lastBackgroundError || 'Loading History data in the background…',
        });
        return;
      }

      const reviews = await computeSectionSumPaginatedIn(historyDoc, {
        startHeadingText: 'Reviews History',
        endHeadingText: 'Question History',
        rowTerminatorRe: /^View review$/i,
      });
      const questions = await computeSectionSumPaginatedIn(historyDoc, {
        startHeadingText: 'Question History',
        endHeadingText: null,
        rowTerminatorRe: /^View question$/i,
      });

      // If History parsing fails but we have cache for the day, keep showing cache (avoid ERR/0 flicker).
      if (!(reviews.found || questions.found) && dayCache) {
        lastStatus = 'ready';
        lastDataSource = 'cache';
        lastBackgroundError = 'History parse failed; showing cached totals.';
        lastPagingInfo = '';
        render({
          reviews: { sum: dayCache.reviews || 0, found: true, rowsCounted: dayCache.countedReviews || 0, rowsSeen: dayCache.countedReviews || 0 },
          questions: { sum: dayCache.questions || 0, found: true, rowsCounted: dayCache.countedQuestions || 0, rowsSeen: dayCache.countedQuestions || 0 },
          note: '',
        });
        return;
      }

      lastStatus = (reviews.found || questions.found) ? 'ready' : 'error';
      if (lastStatus === 'error' && !lastBackgroundError) {
        lastBackgroundError = 'History data loaded, but could not locate expected rows.';
      }
      if (lastStatus === 'ready') {
        lastDataSource = 'history';
        const rp = reviews?.pages || 1;
        const qp = questions?.pages || 1;
        lastPagingInfo = `Paged History: R ${rp}p, Q ${qp}p.`;
        const nextDay = {
          reviews: reviews.sum,
          questions: questions.sum,
          countedReviews: reviews.rowsCounted,
          countedQuestions: questions.rowsCounted,
        };
        saveBestLock(dayKey, nextDay);
        // Never regress the displayed total beneath the best cached value for this day.
        if (dayCache && !shouldOverwriteDayCache(dayCache, nextDay)) {
          render({
            reviews: { sum: dayCache.reviews || 0, found: true, rowsCounted: dayCache.countedReviews || 0, rowsSeen: dayCache.countedReviews || 0 },
            questions: { sum: dayCache.questions || 0, found: true, rowsCounted: dayCache.countedQuestions || 0, rowsSeen: dayCache.countedQuestions || 0 },
            note: 'Using best cached total while history recheck runs.',
          });
          return;
        }
        // If History actually paged across >1 review page, treat it as authoritative for the day.
        if (rp > 1 || shouldOverwriteDayCache(dayCache, nextDay)) {
          saveDayCache(dayKey, nextDay);
        }
      }
      render({ reviews, questions, note: '' });
    } finally {
      recomputeInFlight = false;
      if (recomputeQueued) {
        recomputeQueued = false;
        scheduleRecompute(true);
      }
    }
  }

  // Auto-recompute when the History tables update.
  let pending = null;
  function scheduleRecompute(immediate = false) {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = null;
      recomputeAndRender();
    }, immediate ? 0 : 250);
  }

  // Install discovery hooks as early as possible. With @run-at document-start,
  // this captures API calls during initial app boot.
  installNetworkDiscoveryHooks();

  // UI/DOM bootstrapping: on refresh, `document-start` can run before <head>/<body> exist.
  // If we inject too early, the bar can fail to mount and "disappear".
  let uiBooted = false;
  let bodyObserverInstalled = false;
  let warmupInstalled = false;
  let domObserverInstalled = false;

  function bootUiIfReady() {
    if (uiBooted) return;
    if (!hasDomScaffold()) return;

    uiBooted = true;
    ensureBar();

    // Fire-and-forget initial compute (async safe).
    recomputeAndRender().catch(() => {});

    if (!bodyObserverInstalled) {
      bodyObserverInstalled = true;
      const obs = new MutationObserver((mutations) => {
        const bar = document.getElementById(BAR_ID);
        const iframe = document.getElementById(IFRAME_ID);
        if (bar) {
          const onlyOurUi = mutations.every((m) => {
            const t = m.target;
            return (t instanceof Node) && bar.contains(t);
          });
          if (onlyOurUi) return;
        }
        if (iframe) {
          const onlyOurFrame = mutations.every((m) => {
            const t = m.target;
            return (t instanceof Node) && iframe.contains(t);
          });
          if (onlyOurFrame) return;
        }
        scheduleRecompute();
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // Also re-check periodically (handles day rollover + cases where iframe loads later).
    // Quick warm-up loop to catch iframe load ASAP, then settle into 60s.
    if (!warmupInstalled) {
      warmupInstalled = true;
      let warmupTicks = 0;
      const warmup = window.setInterval(() => {
        warmupTicks += 1;
        scheduleRecompute();
        if (warmupTicks >= 20) window.clearInterval(warmup); // ~10s
      }, 500);
      window.setInterval(() => scheduleRecompute(), 60_000);
    }
  }

  // Try immediately, then on DOM milestones, and also via a DOM observer.
  bootUiIfReady();
  document.addEventListener('readystatechange', bootUiIfReady);
  document.addEventListener('DOMContentLoaded', bootUiIfReady, { once: true });
  window.addEventListener('load', bootUiIfReady, { once: true });

  if (!domObserverInstalled && document.documentElement) {
    domObserverInstalled = true;
    const domObs = new MutationObserver(() => bootUiIfReady());
    domObs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
