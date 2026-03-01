// ==UserScript==
// @name         Udacity Mentor Dashboard - Auto Refresh Queues
// @namespace    local
// @version      1.0.5
// @description  Refresh Reviews & Questions queues every 5 minutes until Reviews refresh is no longer available (review assigned / out of queue).
// @match        https://mentor-dashboard.udacity.com/*
// @run-at       document-idle
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_VERSION = "1.0.5";
  const REFRESH_EVERY_MS = 5 * 60 * 1000; // 5 minutes
  const START_DELAY_MS = 2500;
  const SHOW_BADGE = true; // set to false if you don't want any on-page indicator
  const STOP_REASON_REVIEWS_REFRESH_MISSING =
    "Stopping: Reviews refresh button is no longer available (likely assigned a review / out of queue).";
  const STOP_REASON_USER_DISABLED =
    "Paused: Auto Refresh disabled in extension popup.";
  const STOP_MISSING_THRESHOLD = 3; // consecutive checks before stopping (avoids transient DOM states)
  const RESUME_CHECK_EVERY_MS = 2000; // while stopped, check whether Reviews refresh is back
  const STORAGE_KEY = "udacityMentorAutoRefresh";
  const USER_ENABLED_KEY = "udacityMentorAutoRefreshEnabled";
  const USER_ENABLED_EVENT = "udacity-tools:auto-refresh-enabled";
  const STORAGE_VERSION = 1;

  let timeoutId = null;
  let observer = null;
  let resumeIntervalId = null;
  let stopped = false;
  let lastRunAtMs = null;
  let nextRunAtMs = null;
  let badgeEl = null;
  let reviewsRefreshSeenOnce = false;
  let missingReviewsStreak = 0;
  let lastStopReason = "";

  // Quick fingerprint for debugging in DevTools:
  // type: window.__UDACITY_AUTO_REFRESH__
  const api = {
    version: SCRIPT_VERSION,
    loadedAt: new Date().toISOString(),
    getState: () => ({
      stopped,
      userEnabled: isUserEnabled(),
      lastRunAtMs,
      nextRunAtMs,
      refreshEveryMs: REFRESH_EVERY_MS,
      reviewsRefreshSeenOnce,
      missingReviewsStreak,
    }),
  };
  // Expose on the page window (and top window if accessible) so DevTools can always see it.
  try {
    window.__UDACITY_AUTO_REFRESH__ = api;
  } catch {
    // ignore
  }
  try {
    if (window.top && window.top !== window) window.top.__UDACITY_AUTO_REFRESH__ = api;
  } catch {
    // ignore (cross-origin frames)
  }

  function nowStamp() {
    return new Date().toISOString();
  }

  function isUserEnabled() {
    try {
      const raw = window.localStorage.getItem(USER_ENABLED_KEY);
      if (raw == null) return true;
      const normalized = String(raw).trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    } catch {
      return true;
    }
  }

  function loadPersistedState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || data.v !== STORAGE_VERSION) return;

      if (typeof data.stopped === "boolean") stopped = data.stopped;
      if (typeof data.lastRunAtMs === "number") lastRunAtMs = data.lastRunAtMs;
      if (typeof data.nextRunAtMs === "number") nextRunAtMs = data.nextRunAtMs;
      if (typeof data.reviewsRefreshSeenOnce === "boolean")
        reviewsRefreshSeenOnce = data.reviewsRefreshSeenOnce;
      if (typeof data.missingReviewsStreak === "number")
        missingReviewsStreak = data.missingReviewsStreak;
    } catch {
      // ignore
    }
  }

  function persistState() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: STORAGE_VERSION,
          savedAt: Date.now(),
          stopped,
          lastRunAtMs,
          nextRunAtMs,
          reviewsRefreshSeenOnce,
          missingReviewsStreak,
        }),
      );
    } catch {
      // ignore
    }
  }

  function isOnTargetRoute() {
    // Support both:
    // - https://mentor-dashboard.udacity.com/queue/overview
    // - https://mentor-dashboard.udacity.com/#/queue/overview
    const path = (location.pathname ?? "").toLowerCase();
    const hash = (location.hash ?? "").toLowerCase();
    return path.startsWith("/queue/overview") || hash.includes("#/queue/overview");
  }

  function formatCountdown(msUntil) {
    const clamped = Math.max(0, msUntil);
    const totalSec = Math.floor(clamped / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const ss = String(totalSec % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function ensureBadge() {
    if (!SHOW_BADGE) return null;
    if (badgeEl) return badgeEl;
    const el = document.createElement("div");
    el.id = "udacity-mentor-auto-refresh-badge";
    el.style.position = "fixed";
    el.style.right = "12px";
    el.style.bottom = "12px";
    el.style.zIndex = "2147483647";
    el.style.background = "rgba(0, 0, 0, 0.82)";
    el.style.color = "#fff";
    el.style.padding = "8px 10px";
    el.style.borderRadius = "10px";
    el.style.border = "1px solid rgba(255,255,255,0.18)";
    el.style.font = "12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    el.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
    el.style.pointerEvents = "none";
    (document.body || document.documentElement).appendChild(el);
    badgeEl = el;
    return el;
  }

  function renderBadge(extra = "") {
    const el = ensureBadge();
    if (!el) return;
    const state = !isUserEnabled() ? "DISABLED" : stopped ? "STOPPED" : "RUNNING";
    const nextIn =
      !stopped && typeof nextRunAtMs === "number"
        ? formatCountdown(nextRunAtMs - Date.now())
        : "—";
    const lastAt =
      typeof lastRunAtMs === "number" ? new Date(lastRunAtMs).toLocaleTimeString() : "—";
    el.textContent =
      `Auto Refresh: ${state}\nLast: ${lastAt}\nNext in: ${nextIn}` + (extra ? `\n${extra}` : "");
  }

  function normalizeText(s) {
    return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    return normalizeText(btn.getAttribute("aria-disabled")) === "true";
  }

  function getEnabledReviewsRefreshButton() {
    const btn = findRefreshButtonForQueue("Reviews");
    if (!btn) return null;
    if (isButtonDisabled(btn)) return null;
    return btn;
  }

  function maybeResume(reason) {
    if (!stopped) return false;
    if (!isUserEnabled()) return false;
    if (!isOnTargetRoute()) return false;

    const reviewsBtn = getEnabledReviewsRefreshButton();
    if (!reviewsBtn) return false;

    stopped = false;
    reviewsRefreshSeenOnce = true;
    missingReviewsStreak = 0;

    nextRunAtMs = Date.now() + 750;
    renderBadge(`Resumed (${reason})`);
    console.log(`[auto-refresh][${nowStamp()}] Resumed (${reason}).`);
    persistState();
    scheduleNextTick();

    clearResumeWatcher();
    return true;
  }

  function clearResumeWatcher() {
    if (resumeIntervalId !== null) {
      clearInterval(resumeIntervalId);
      resumeIntervalId = null;
    }
  }

  function startResumeWatcher() {
    if (resumeIntervalId !== null) return;
    if (!isUserEnabled()) return;
    resumeIntervalId = window.setInterval(() => {
      if (!isUserEnabled()) {
        enforceUserSetting("disabled in popup");
        return;
      }
      maybeResume("queue re-entered");
    }, RESUME_CHECK_EVERY_MS);
  }

  function findRefreshButtonForQueue(queueLabel) {
    const label = normalizeText(queueLabel);
    // Search common text-bearing elements; climb a few ancestors to find the nearby Refresh button.
    const textNodes = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p,strong"),
    );

    for (const el of textNodes) {
      if (normalizeText(el.textContent) !== label) continue;

      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        const buttons = Array.from(node.querySelectorAll("button"));
        const refreshBtn = buttons.find((b) => normalizeText(b.textContent).includes("refresh"));
        if (refreshBtn) return refreshBtn;
        node = node.parentElement;
      }
    }

    return null;
  }

  // Stop rule (robust):
  // - Specifically track the Reviews refresh button.
  // - Only stop after we have seen it at least once AND it is missing/disabled for several consecutive checks.
  function shouldStop() {
    const reviewsRefreshBtn = findRefreshButtonForQueue("Reviews");

    if (reviewsRefreshBtn && !isButtonDisabled(reviewsRefreshBtn)) {
      reviewsRefreshSeenOnce = true;
      missingReviewsStreak = 0;
      return false;
    }

    // Don't stop until we've confirmed Reviews refresh existed at least once (avoid early-load false stops).
    if (!reviewsRefreshSeenOnce) return false;

    missingReviewsStreak += 1;
    return missingReviewsStreak >= STOP_MISSING_THRESHOLD;
  }

  function clickRefreshButtons() {
    const reviewsRefreshBtn = findRefreshButtonForQueue("Reviews");
    const questionsRefreshBtn = findRefreshButtonForQueue("Questions");

    const clicked = [];
    if (reviewsRefreshBtn && !isButtonDisabled(reviewsRefreshBtn)) {
      reviewsRefreshSeenOnce = true;
      reviewsRefreshBtn.click();
      clicked.push("Reviews");
    }
    if (questionsRefreshBtn && !isButtonDisabled(questionsRefreshBtn)) {
      questionsRefreshBtn.click();
      clicked.push("Questions");
    }

    if (clicked.length === 0) {
      console.log(`[auto-refresh][${nowStamp()}] No enabled refresh buttons found.`);
      renderBadge("No enabled refresh buttons found");
      return;
    }

    console.log(`[auto-refresh][${nowStamp()}] Clicked Refresh for: ${clicked.join(", ")}.`);
  }

  function stop(reason, options = {}) {
    const watchForResume = options.watchForResume !== false;
    const force = options.force === true;
    if (stopped && !force) return;
    const wasStopped = stopped;
    stopped = true;

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!wasStopped || reason !== lastStopReason) {
      console.log(`[auto-refresh][${nowStamp()}] ${reason}`);
      lastStopReason = reason;
    }
    renderBadge(reason);
    persistState();
    try {
      // Low-friction visual signal without being too disruptive.
      document.title = `[STOPPED] ${document.title.replace(/^\[STOPPED\]\s*/, "")}`;
    } catch {
      // ignore
    }

    // Keep watching for when you re-enter the queue (Reviews refresh comes back).
    if (watchForResume) startResumeWatcher();
    else clearResumeWatcher();
  }

  function enforceUserSetting(reason) {
    if (!isUserEnabled()) {
      stop(STOP_REASON_USER_DISABLED, { watchForResume: false, force: true });
      return true;
    }

    if (stopped) {
      const resumed = maybeResume(reason || "enabled in popup");
      if (!resumed) {
        renderBadge("Enabled (waiting for queue)");
        persistState();
        startResumeWatcher();
      }
    }
    return false;
  }

  function tick() {
    if (enforceUserSetting("enabled in popup")) return;
    if (shouldStop()) {
      stop(`${STOP_REASON_REVIEWS_REFRESH_MISSING} (streak=${missingReviewsStreak})`);
      return;
    }
    lastRunAtMs = Date.now();
    nextRunAtMs = lastRunAtMs + REFRESH_EVERY_MS;
    renderBadge();
    clickRefreshButtons();
    persistState();
  }

  function scheduleNextTick() {
    if (enforceUserSetting("enabled in popup")) return;
    if (stopped) return;
    if (!isOnTargetRoute()) return;
    if (typeof nextRunAtMs !== "number") nextRunAtMs = Date.now() + START_DELAY_MS;

    const delay = Math.max(0, nextRunAtMs - Date.now());
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      tick();
      // If we got stopped inside tick(), do not schedule again.
      if (!stopped) scheduleNextTick();
    }, delay);
  }

  function start() {
    if (timeoutId !== null) return;
    if (!isOnTargetRoute()) {
      renderBadge("Not active on this page");
      return;
    }

    console.log(`[auto-refresh] userscript loaded v${SCRIPT_VERSION}`);
    console.log(
      `[auto-refresh][${nowStamp()}] Started. Will refresh every ${
        REFRESH_EVERY_MS / 60000
      } minutes.`,
    );
    loadPersistedState();

    // If there was an existing schedule, keep it across reloads; otherwise schedule initial tick.
    if (typeof nextRunAtMs !== "number") nextRunAtMs = Date.now() + START_DELAY_MS;
    if (nextRunAtMs <= Date.now()) nextRunAtMs = Date.now() + 750; // run soon if overdue
    renderBadge(stopped ? "Paused (waiting for queue)" : "Scheduled");
    persistState();
    enforceUserSetting("enabled in popup");
    if (!stopped) scheduleNextTick();
    else startResumeWatcher();

    // Stop quickly if the page updates and removes/locks the reviews refresh button.
    observer = new MutationObserver(() => {
      if (enforceUserSetting("enabled in popup")) return;
      if (stopped) {
        maybeResume("DOM update");
        return;
      }
      if (shouldStop()) stop(STOP_REASON_REVIEWS_REFRESH_MISSING);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Best-effort persistence on refresh/close.
    window.addEventListener("beforeunload", () => {
      persistState();
    });
    window.addEventListener("storage", (event) => {
      if (event.key === USER_ENABLED_KEY) enforceUserSetting("synced setting");
    });
    window.addEventListener(USER_ENABLED_EVENT, () => {
      enforceUserSetting("popup toggle");
    });
  }

  start();
})();
