"use strict";

const GET_LEDGER = "udacity-tools:get-ledger";

const elHeroStatus = document.getElementById("hero-status");
const elMonthInput = document.getElementById("month-input");
const elRefreshButton = document.getElementById("refresh-btn");
const elSummaryTotal = document.getElementById("summary-total");
const elSummaryReviews = document.getElementById("summary-reviews");
const elSummaryQuestions = document.getElementById("summary-questions");
const elSummaryDays = document.getElementById("summary-days");
const elTableSubtitle = document.getElementById("table-subtitle");
const elSyncMeta = document.getElementById("sync-meta");
const elLedgerBody = document.getElementById("ledger-body");
const elFooterReviews = document.getElementById("footer-reviews");
const elFooterQuestions = document.getElementById("footer-questions");
const elFooterTotal = document.getElementById("footer-total");

let targetTabId = null;
let ledgerState = null;

function formatMoney(value) {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDateLabel(dayKey) {
  const [year, month, day] = String(dayKey || "").split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return dayKey || "-";
  const dt = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

function formatUpdatedAt(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString();
}

function setHeroStatus(text) {
  elHeroStatus.textContent = text;
}

function parseMonthFromSearch() {
  const params = new URLSearchParams(window.location.search);
  const month = (params.get("month") || "").trim();
  return /^\d{4}-\d{2}$/.test(month) ? month : "";
}

function readTabId() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("tabId");
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getLedgerMonths(response) {
  const byDay = response?.ledger?.ledger?.byDay;
  if (!byDay || typeof byDay !== "object") return [];
  return Array.from(new Set(Object.keys(byDay).map((dayKey) => String(dayKey).slice(0, 7))))
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .sort()
    .reverse();
}

function getDaysForMonth(monthKey, currentMonth, ledgerByDay) {
  const out = [];
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return out;
  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  let endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = ledgerState?.ledger?.today || "";
  if (monthKey === currentMonth && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
    endDay = Number(today.slice(8, 10));
  } else if (ledgerByDay && typeof ledgerByDay === "object") {
    const presentDays = Object.keys(ledgerByDay)
      .filter((dayKey) => dayKey.startsWith(`${monthKey}-`))
      .map((dayKey) => Number(dayKey.slice(8, 10)))
      .filter((value) => Number.isFinite(value));
    if (presentDays.length) endDay = Math.max(...presentDays);
  }
  for (let day = 1; day <= endDay; day += 1) {
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    out.push(key);
  }
  if (start.getUTCMonth() !== month - 1) return [];
  return out;
}

function renderEmpty(message) {
  elLedgerBody.innerHTML = `<tr><td colspan="4" class="empty-row">${message}</td></tr>`;
  elSummaryTotal.textContent = "-";
  elSummaryReviews.textContent = "-";
  elSummaryQuestions.textContent = "-";
  elSummaryDays.textContent = "-";
  elFooterReviews.textContent = "-";
  elFooterQuestions.textContent = "-";
  elFooterTotal.textContent = "-";
  elTableSubtitle.textContent = "-";
  elSyncMeta.textContent = "-";
}

function renderLedger() {
  const state = ledgerState?.ledger;
  const storedLedger = state?.ledger;
  const byDay = storedLedger?.byDay;
  if (!state?.present || !byDay || typeof byDay !== "object") {
    renderEmpty("No stored ledger data found on this Udacity tab yet.");
    return;
  }

  const months = getLedgerMonths(ledgerState);
  const selectedMonth = /^\d{4}-\d{2}$/.test(elMonthInput.value)
    ? elMonthInput.value
    : (parseMonthFromSearch() || state.currentMonth || months[0] || "");

  if (selectedMonth) elMonthInput.value = selectedMonth;

  const dayKeys = getDaysForMonth(selectedMonth, state.currentMonth, byDay);
  if (!dayKeys.length) {
    renderEmpty("No ledger rows stored for the selected month.");
    return;
  }

  let totalReviews = 0;
  let totalQuestions = 0;
  let storedDays = 0;
  const rows = dayKeys.map((dayKey) => {
    const row = byDay[dayKey] || null;
    const reviews = Number(row?.reviews || 0);
    const questions = Number(row?.questions || 0);
    const total = reviews + questions;
    if (row) storedDays += 1;
    totalReviews += reviews;
    totalQuestions += questions;
    return `
      <tr>
        <td>${formatDateLabel(dayKey)}</td>
        <td>${formatMoney(reviews)}</td>
        <td>${formatMoney(questions)}</td>
        <td>${formatMoney(total)}</td>
      </tr>
    `;
  });

  const monthTotal = totalReviews + totalQuestions;
  const monthSync = storedLedger?.monthSync?.[selectedMonth] || null;

  elLedgerBody.innerHTML = rows.join("");
  elSummaryTotal.textContent = formatMoney(monthTotal);
  elSummaryReviews.textContent = formatMoney(totalReviews);
  elSummaryQuestions.textContent = formatMoney(totalQuestions);
  elSummaryDays.textContent = `${storedDays}/${dayKeys.length}`;
  elFooterReviews.textContent = formatMoney(totalReviews);
  elFooterQuestions.textContent = formatMoney(totalQuestions);
  elFooterTotal.textContent = formatMoney(monthTotal);
  elTableSubtitle.textContent = `Showing ${selectedMonth} from stored local ledger data in ${state.timeZone}.`;
  elSyncMeta.textContent = monthSync
    ? `Last month sync: ${formatUpdatedAt(monthSync.at)}${monthSync.source ? ` | ${monthSync.source}` : ""}`
    : `Last row update: ${formatUpdatedAt(Math.max(...dayKeys.map((dayKey) => Number(byDay[dayKey]?.updatedAt || 0))))}`;
}

async function loadLedger() {
  if (!targetTabId) {
    setHeroStatus("Open this page from the popup while a Udacity tab is active.");
    renderEmpty("No target Udacity tab was provided.");
    return;
  }

  try {
    setHeroStatus("Reading stored ledger from the Udacity tab...");
    const response = await sendMessageToTab(targetTabId, { type: GET_LEDGER });
    if (!response?.ok) {
      throw new Error("Ledger message failed");
    }
    ledgerState = response;
    const months = getLedgerMonths(ledgerState);
    if (!/^\d{4}-\d{2}$/.test(elMonthInput.value)) {
      elMonthInput.value = parseMonthFromSearch() || response.ledger?.currentMonth || months[0] || "";
    }
    setHeroStatus(`Connected to ${response.ledger?.pageUrl || "the Udacity tab"}.`);
    renderLedger();
  } catch (_) {
    setHeroStatus("Could not read ledger from the Udacity tab. Re-open from the popup.");
    renderEmpty("Ledger data could not be loaded from the selected tab.");
  }
}

elMonthInput.addEventListener("change", () => {
  renderLedger();
});

elRefreshButton.addEventListener("click", () => {
  loadLedger();
});

targetTabId = readTabId();
loadLedger();
