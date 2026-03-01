(() => {
  "use strict";

  const PREFS_KEY = "udacityMentorDashboardUiPrefsV1";
  const STYLE_ID = "udacity-mentor-dashboard-extension-visibility-style";
  const AUTO_REFRESH_ENABLED_KEY = "udacityMentorAutoRefreshEnabled";
  const AUTO_REFRESH_EVENT = "udacity-tools:auto-refresh-enabled";
  const DEFAULT_PREFS = Object.freeze({
    hideIncomeBox: false,
    hideAutoRefreshBox: false,
    autoRefreshEnabled: true,
  });

  function normalizePrefs(raw) {
    return {
      hideIncomeBox: !!raw?.hideIncomeBox,
      hideAutoRefreshBox: !!raw?.hideAutoRefreshBox,
      autoRefreshEnabled: raw?.autoRefreshEnabled !== false,
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

  function ensureVisibilityStyle() {
    let style = document.getElementById(STYLE_ID);
    if (style) return style;
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function applyPrefs(prefs) {
    const style = ensureVisibilityStyle();
    const rules = [];
    if (prefs.hideIncomeBox) {
      rules.push("#tm-udacity-daily-income-bar { display: none !important; }");
    }
    if (prefs.hideAutoRefreshBox) {
      rules.push("#udacity-mentor-auto-refresh-badge { display: none !important; }");
    }
    style.textContent = rules.join("\n");
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

  async function handleGetState(sendResponse) {
    const prefs = await getPrefs();
    applyPrefs(prefs);
    sendResponse({
      ok: true,
      prefs,
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
    applyPrefs(saved.prefs);
    syncAutoRefreshEnabled(saved.prefs);
    sendResponse({
      ok: saved.ok,
      prefs: saved.prefs,
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
  });

  getPrefs()
    .then((prefs) => {
      applyPrefs(prefs);
      syncAutoRefreshEnabled(prefs);
    })
    .catch(() => {
      const fallback = { ...DEFAULT_PREFS };
      applyPrefs(fallback);
      syncAutoRefreshEnabled(fallback);
    });
})();
