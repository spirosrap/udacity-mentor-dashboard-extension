"use strict";

const GET_STATE = "udacity-tools:get-state";
const SET_PREFS = "udacity-tools:set-prefs";

const elStatus = document.getElementById("status");
const elIncomeReviews = document.getElementById("income-reviews");
const elIncomeQuestions = document.getElementById("income-questions");
const elIncomeTotal = document.getElementById("income-total");
const elIncomeStatus = document.getElementById("income-status");
const elIncomeDate = document.getElementById("income-date");
const elIncomeSummary = document.getElementById("income-summary");
const elIncomeDebugWrap = document.getElementById("income-debug-wrap");
const elIncomeDebug = document.getElementById("income-debug");
const elToggleDailyIncomeEnabled = document.getElementById("toggle-daily-income-enabled");
const elAutoRefreshText = document.getElementById("auto-refresh-text");
const elToggleAutoRefreshEnabled = document.getElementById("toggle-auto-refresh-enabled");
const elToggleIncome = document.getElementById("toggle-income");
const elToggleRefresh = document.getElementById("toggle-refresh");
const elRefreshButton = document.getElementById("refresh-btn");

let activeTabId = null;

function setStatus(text) {
  elStatus.textContent = text;
}

function normalizeMultiline(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "-";
  return trimmed.replace(/\s*\n\s*/g, " | ");
}

function summarizeIncomeMeta(meta) {
  const text = (meta || "").trim();
  if (!text) return "-";
  const idx = text.indexOf(" Endpoints:");
  if (idx === -1) return text;
  return text.slice(0, idx).trim();
}

function setIncomeUnavailable() {
  elIncomeReviews.textContent = "-";
  elIncomeQuestions.textContent = "-";
  elIncomeTotal.textContent = "-";
  elIncomeStatus.textContent = "-";
  elIncomeDate.textContent = "-";
  elIncomeSummary.textContent = "Daily Income box not detected on this tab.";
  elIncomeDebug.textContent = "-";
  elIncomeDebugWrap.open = false;
}

function setAutoRefreshUnavailable() {
  elAutoRefreshText.textContent = "Auto Refresh box not detected on this tab.";
}

function renderFromState(state) {
  const income = state?.income || {};
  const autoRefresh = state?.autoRefresh || {};
  const prefs = state?.prefs || {};

  elToggleDailyIncomeEnabled.checked = prefs.dailyIncomeEnabled !== false;
  elToggleAutoRefreshEnabled.checked = prefs.autoRefreshEnabled !== false;
  elToggleIncome.checked = !!prefs.hideIncomeBox;
  elToggleRefresh.checked = !!prefs.hideAutoRefreshBox;

  if (income.present) {
    elIncomeReviews.textContent = income.reviews || "-";
    elIncomeQuestions.textContent = income.questions || "-";
    elIncomeTotal.textContent = income.total || "-";
    elIncomeStatus.textContent = income.status || "-";
    elIncomeDate.textContent = income.targetDate || "-";
    const fullMeta = (income.meta || "").trim();
    elIncomeSummary.textContent = summarizeIncomeMeta(fullMeta);
    elIncomeDebug.textContent = fullMeta || "-";
  } else {
    setIncomeUnavailable();
  }

  if (autoRefresh.present) {
    const badge = normalizeMultiline(autoRefresh.badgeText);
    const api = autoRefresh.apiState
      ? JSON.stringify(autoRefresh.apiState)
      : null;
    elAutoRefreshText.textContent = api ? `${badge}\n${api}` : badge;
  } else {
    setAutoRefreshUnavailable();
  }
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs?.[0] || null);
    });
  });
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

async function loadState() {
  try {
    if (!activeTabId) {
      const tab = await getActiveTab();
      activeTabId = tab?.id || null;
    }

    if (!activeTabId) {
      setStatus("No active browser tab.");
      setIncomeUnavailable();
      setAutoRefreshUnavailable();
      return;
    }

    const state = await sendMessageToTab(activeTabId, { type: GET_STATE });
    if (!state?.ok) {
      setStatus("Could not load state from this tab.");
      return;
    }

    setStatus("Connected to active Udacity tab.");
    renderFromState(state);
  } catch (_) {
    setStatus("Open a mentor-dashboard.udacity.com tab, then click Refresh.");
    setIncomeUnavailable();
    setAutoRefreshUnavailable();
  }
}

async function savePrefs() {
  if (!activeTabId) {
    await loadState();
    if (!activeTabId) return;
  }

  try {
    await sendMessageToTab(activeTabId, {
      type: SET_PREFS,
      prefs: {
        dailyIncomeEnabled: elToggleDailyIncomeEnabled.checked,
        autoRefreshEnabled: elToggleAutoRefreshEnabled.checked,
        hideIncomeBox: elToggleIncome.checked,
        hideAutoRefreshBox: elToggleRefresh.checked,
      },
    });
    await loadState();
  } catch (_) {
    setStatus("Failed to update visibility on this tab.");
  }
}

elToggleDailyIncomeEnabled.addEventListener("change", () => {
  savePrefs();
});

elToggleAutoRefreshEnabled.addEventListener("change", () => {
  savePrefs();
});

elToggleIncome.addEventListener("change", () => {
  savePrefs();
});

elToggleRefresh.addEventListener("change", () => {
  savePrefs();
});

elRefreshButton.addEventListener("click", () => {
  loadState();
});

loadState();
