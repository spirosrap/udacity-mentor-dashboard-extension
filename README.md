# Udacity Mentor Dashboard Tools (Brave/Chrome Extension)

This extension combines both scripts into one package and adds a popup UI:

- Daily income counter (`daily-income.js`)
- Queue auto-refresh (`auto-refresh.js`)
- Bridge/messaging layer (`bridge.js`)
- Popup (`popup.html`, `popup.js`, `popup.css`)

## Included behavior

- Daily Income Counter runs on: `https://mentor-dashboard.udacity.com/queue/*`
- Auto Refresh runs on: `https://mentor-dashboard.udacity.com/*`

## Popup demo

![Udacity Mentor Tools popup demo](assets/extension-popup-demo.png)

## Install in Brave (or Chrome)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the extension project folder (the one containing `manifest.json`).

## How it works

- `daily-income.js` is loaded at `document_start` so API discovery hooks are installed early.
- `daily-income.js` and `auto-refresh.js` run in the page's main world to preserve Tampermonkey-like behavior.
- `bridge.js` runs as a normal extension content script for `chrome.runtime` messaging and `chrome.storage` support.

## Popup controls

- Shows live Daily Income values (R/Q/T/status/date/details).
- Includes an "Open Ledger Table" action that opens a dedicated extension page for the stored per-day ledger.
- Keeps full Daily Income debug text behind a collapsed "Show debug info" section.
- Lets you enable/disable Daily Income calculations.
- Shows Auto Refresh status text.
- Lets you enable/disable Auto Refresh actions.
- Lets you hide/show the Daily Income and Auto Refresh boxes on the page.

## Defaults and storage

- Visibility preferences are saved in extension storage and applied on reload.
- Low-load defaults: Daily Income starts disabled; Auto Refresh starts enabled.
- Auto Refresh countdown resets when you manually reload the page.
- Daily Income also keeps a bounded per-day ledger in page `localStorage` under `tmUdacityDailyIncomeLedger`, seeded from existing cache and refreshed with a once-per-day current-month backfill.
- The ledger page reads that stored data from the active Udacity tab without refreshing the dashboard.

## Reliability improvements

- Daily Income parsing now handles rows with multiple dollar amounts (for example payout + bonus) more accurately.
- History parsing now reads semantic grid rows (`role=row`) with fallback logic, reducing missed entries when row action labels vary.
- Discovery avoids false-positive endpoints (for example `certifications`, `assigned`, and queue-style endpoints) and prioritizes completed/history sources.
- API pagination now boosts page size (`per_page`) to reduce first-page-only undercount scenarios.
- Question GraphQL pagination now advances `afterCursor` correctly, so current-month question backfills can span multiple pages.
- Captured question-history GraphQL requests are normalized back to page 1 before replay, so stored cursors cannot silently skip recent days during ledger backfills.
- Day cache/lock entries are schema-versioned to avoid stale totals after major logic updates.
