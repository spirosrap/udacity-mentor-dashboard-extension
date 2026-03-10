(() => {
  "use strict";

  const PREFS_KEY = "udacityMentorDashboardUiPrefsV1";
  const VISIBILITY_SESSION_KEY = "udacityMentorDashboardUiVisibilityV1";
  const STYLE_ID = "udacity-mentor-dashboard-extension-visibility-style";
  const AUTO_REFRESH_ENABLED_KEY = "udacityMentorAutoRefreshEnabled";
  const AUTO_REFRESH_EVENT = "udacity-tools:auto-refresh-enabled";
  const DAILY_INCOME_ENABLED_KEY = "udacityMentorDailyIncomeEnabled";
  const DAILY_INCOME_EVENT = "udacity-tools:daily-income-enabled";
  const LEDGER_KEY = "tmUdacityDailyIncomeLedger";
  const LEDGER_TIME_ZONE = "Europe/Athens";
  const DEFAULT_PREFS = Object.freeze({
    dailyIncomeEnabled: false,
    autoRefreshEnabled: true,
  });
  const DEFAULT_VISIBILITY = Object.freeze({
    hideIncomeBox: false,
    hideAutoRefreshBox: false,
  });

  function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function normalizePrefs(raw) {
    return {
      dailyIncomeEnabled: hasOwn(raw, "dailyIncomeEnabled")
        ? raw?.dailyIncomeEnabled !== false
        : DEFAULT_PREFS.dailyIncomeEnabled,
      autoRefreshEnabled: hasOwn(raw, "autoRefreshEnabled")
        ? raw?.autoRefreshEnabled !== false
        : DEFAULT_PREFS.autoRefreshEnabled,
    };
  }

  function normalizeVisibility(raw) {
    return {
      hideIncomeBox: !!raw?.hideIncomeBox,
      hideAutoRefreshBox: !!raw?.hideAutoRefreshBox,
    };
  }

  function getPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(PREFS_KEY, (items) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULT_PREFS });
            return;
          }
          resolve({ ...DEFAULT_PREFS, ...normalizePrefs(items?.[PREFS_KEY]) });
        });
      } catch (_) {
        resolve({ ...DEFAULT_PREFS });
      }
    });
  }

  function setPrefs(prefs) {
    return new Promise((resolve) => {
      try {
        const normalized = normalizePrefs(prefs);
        chrome.storage.local.set({ [PREFS_KEY]: normalized }, () => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, prefs: { ...DEFAULT_PREFS } });
            return;
          }
          resolve({ ok: true, prefs: normalized });
        });
      } catch (_) {
        resolve({ ok: false, prefs: { ...DEFAULT_PREFS } });
      }
    });
  }

  function getVisibility() {
    try {
      const raw = window.sessionStorage.getItem(VISIBILITY_SESSION_KEY);
      if (!raw) return { ...DEFAULT_VISIBILITY };
      return { ...DEFAULT_VISIBILITY, ...normalizeVisibility(JSON.parse(raw)) };
    } catch (_) {
      return { ...DEFAULT_VISIBILITY };
    }
  }

  function setVisibility(visibility) {
    try {
      const normalized = normalizeVisibility(visibility);
      window.sessionStorage.setItem(VISIBILITY_SESSION_KEY, JSON.stringify(normalized));
      return { ok: true, visibility: normalized };
    } catch (_) {
      return { ok: false, visibility: { ...DEFAULT_VISIBILITY } };
    }
  }

  function ensureVisibilityStyle() {
    let style = document.getElementById(STYLE_ID);
    if (style) return style;
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function applyVisibility(visibility) {
    const style = ensureVisibilityStyle();
    const rules = [];
    if (visibility.hideIncomeBox) {
      rules.push("#tm-udacity-daily-income-bar { display: none !important; }");
    }
    if (visibility.hideAutoRefreshBox) {
      rules.push("#udacity-mentor-auto-refresh-badge { display: none !important; }");
    }
    style.textContent = rules.join("\n");
  }

  function applyAndSyncPrefs(prefs) {
    const normalized = { ...DEFAULT_PREFS, ...normalizePrefs(prefs) };
    syncAutoRefreshEnabled(normalized);
    syncDailyIncomeEnabled(normalized);
    return normalized;
  }

  function syncAutoRefreshEnabled(prefs) {
    const enabled = prefs?.autoRefreshEnabled !== false;
    try {
      window.localStorage.setItem(AUTO_REFRESH_ENABLED_KEY, enabled ? "1" : "0");
    } catch (_) {
      // ignore
    }
    try {
      window.dispatchEvent(
        new CustomEvent(AUTO_REFRESH_EVENT, {
          detail: { enabled },
        }),
      );
    } catch (_) {
      // ignore
    }
  }

  function syncDailyIncomeEnabled(prefs) {
    const enabled = prefs?.dailyIncomeEnabled !== false;
    try {
      window.localStorage.setItem(DAILY_INCOME_ENABLED_KEY, enabled ? "1" : "0");
    } catch (_) {
      // ignore
    }
    try {
      window.dispatchEvent(
        new CustomEvent(DAILY_INCOME_EVENT, {
          detail: { enabled },
        }),
      );
    } catch (_) {
      // ignore
    }
  }

  function text(root, selector) {
    const node = root ? root.querySelector(selector) : null;
    return (node?.textContent || "").trim();
  }

  function getIncomeState() {
    const root = document.getElementById("tm-udacity-daily-income-bar");
    if (!root) {
      return {
        present: false,
        reviews: "",
        questions: "",
        total: "",
        status: "",
        meta: "",
        targetDate: "",
      };
    }

    const dateInput = root.querySelector(".tm-date");
    return {
      present: true,
      reviews: text(root, ".tm-reviews"),
      questions: text(root, ".tm-questions"),
      total: text(root, ".tm-total-value"),
      status: text(root, ".tm-status"),
      meta: text(root, ".tm-meta-1"),
      targetDate: (dateInput?.value || "").trim(),
    };
  }

  function getAutoRefreshState() {
    const badge = document.getElementById("udacity-mentor-auto-refresh-badge");
    let apiState = null;
    try {
      if (window.__UDACITY_AUTO_REFRESH__ && typeof window.__UDACITY_AUTO_REFRESH__.getState === "function") {
        apiState = window.__UDACITY_AUTO_REFRESH__.getState();
      }
    } catch (_) {
      apiState = null;
    }

    return {
      present: !!badge,
      badgeText: (badge?.textContent || "").trim(),
      apiState,
    };
  }

  function getTodayDayKey() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: LEDGER_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function getLedgerState() {
    let ledger = null;
    try {
      const raw = window.localStorage.getItem(LEDGER_KEY);
      ledger = raw ? JSON.parse(raw) : null;
    } catch (_) {
      ledger = null;
    }

    const today = getTodayDayKey();
    return {
      present: !!(ledger && typeof ledger === "object" && ledger.byDay && typeof ledger.byDay === "object"),
      ledger,
      today,
      currentMonth: today.slice(0, 7),
      timeZone: LEDGER_TIME_ZONE,
      pageUrl: location.href,
    };
  }

  async function handleGetState(sendResponse) {
    const prefs = await getPrefs();
    const visibility = getVisibility();
    applyVisibility(visibility);
    applyAndSyncPrefs(prefs);
    sendResponse({
      ok: true,
      prefs,
      visibility,
      income: getIncomeState(),
      autoRefresh: getAutoRefreshState(),
      pageUrl: location.href,
    });
  }

  async function handleSetPrefs(message, sendResponse) {
    const current = await getPrefs();
    const next = {
      ...current,
      ...normalizePrefs(message?.prefs || {}),
    };
    const saved = await setPrefs(next);
    const visibility = getVisibility();
    applyVisibility(visibility);
    applyAndSyncPrefs(saved.prefs);
    sendResponse({
      ok: saved.ok,
      prefs: saved.prefs,
      visibility,
    });
  }

  function handleSetVisibility(message, sendResponse) {
    const current = getVisibility();
    const next = {
      ...current,
      ...normalizeVisibility(message?.visibility || {}),
    };
    const saved = setVisibility(next);
    applyVisibility(saved.visibility);
    sendResponse({
      ok: saved.ok,
      visibility: saved.visibility,
    });
  }

  function handleGetLedger(sendResponse) {
    sendResponse({
      ok: true,
      ledger: getLedgerState(),
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "udacity-tools:get-state") {
      handleGetState(sendResponse);
      return true;
    }
    if (message.type === "udacity-tools:set-prefs") {
      handleSetPrefs(message, sendResponse);
      return true;
    }
    if (message.type === "udacity-tools:set-visibility") {
      handleSetVisibility(message, sendResponse);
      return true;
    }
    if (message.type === "udacity-tools:get-ledger") {
      handleGetLedger(sendResponse);
      return;
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes || !Object.prototype.hasOwnProperty.call(changes, PREFS_KEY)) return;
      const nextPrefs = changes[PREFS_KEY]?.newValue;
      applyAndSyncPrefs(nextPrefs);
    });
  } catch (_) {
    // ignore
  }

  getPrefs()
    .then((prefs) => {
      applyVisibility(getVisibility());
      applyAndSyncPrefs(prefs);
    })
    .catch(() => {
      applyVisibility(getVisibility());
      applyAndSyncPrefs({ ...DEFAULT_PREFS });
    });
})();
