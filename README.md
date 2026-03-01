# Udacity Mentor Dashboard Tools (Brave/Chrome Extension)

This extension combines both scripts into one package:

- Daily income counter (`daily-income.js`)
- Queue auto-refresh (`auto-refresh.js`)

## Included behavior

- Daily Income Counter runs on: `https://mentor-dashboard.udacity.com/queue/*`
- Auto Refresh runs on: `https://mentor-dashboard.udacity.com/*`

## Install in Brave (or Chrome)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/spiros/udacity-mentor-dashboard-extension`

## Notes

- `daily-income.js` is loaded at `document_start` so API discovery hooks are installed early.
- Both scripts run in the page's main world to preserve Tampermonkey-like behavior.
- The original script logic is preserved as-is.
