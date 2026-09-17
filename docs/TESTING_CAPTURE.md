# Testing OpenCluely Capture Pipeline

This guide shows how to verify that OpenCluely's capture mechanisms work correctly, without needing a live proctored exam.

## The Problem

Your previous test against HackerRank didn't capture keystrokes/tab-switches because:

1. **capture.js is a network tap** — it only sees HTTP traffic (fetch/XHR/sendBeacon/WebSocket)
2. **HackerRank's proctoring was disabled** in that practice test — no behavioral data was being uploaded
3. **Keystrokes are client-side events** — they only become visible to the tap if the page's JavaScript sends them over the network

## The Solution: Local Mock Proctor

We've created a self-contained test environment that simulates a proctored test page.

### Files Created

| File | Purpose |
|------|---------|
| `test-proctor.html` | Mock test page that captures keystrokes, tab switches, paste events, and screenshot attempts |
| `scripts/mock-proctor-server.js` | Local server that serves the page and receives captured events at `/log` |

### Quick Start

```bash
# Terminal 1: Start the mock server
node scripts/mock-proctor-server.js 3000

# Terminal 2: Run OpenCluely (or just open the page in a browser)
# Then inject capture.js into the page
```

### Step-by-Step Test

1. **Start the server:**
   ```bash
   node scripts/mock-proctor-server.js
   ```

2. **Open the test page:**
   - Navigate to `http://localhost:3000` in Chrome/Firefox
   - Or use OpenCluely's browser if it supports loading local URLs

3. **Inject capture.js:**
   - Open DevTools Console (F12)
   - Paste the contents of `capture.js` and press Enter
   - You should see: `[Capture] Network tap installed`

4. **Generate test events:**
   - Type in the textarea → should see `keydown` events
   - Switch to another tab and back → should see `visibilitychange` events
   - Paste some text → should see `paste` event
   - Click "Simulate Screenshot Upload" → should see `screenshot_attempt` event

5. **Verify capture:**
   - Check the mock server console — it logs all received events
   - Check capture.js output — it should show the same events being intercepted

### What Success Looks Like

When everything works, you'll see this flow:

```
[Page] keydown event fired
  ↓
[Page] fetch('/log', {type: 'keydown', ...})
  ↓
[capture.js] Intercepts fetch call
  ↓
[Mock Server] Receives POST /log
  ↓
[Console] Logs the captured event
```

### Testing Screenshots Specifically

The mock page includes a screenshot simulation that:
1. Logs a `screenshot_attempt` event
2. Attempts to use `getDisplayMedia` (the real API proctoring services use)

To test actual screen capture:
1. Click "Simulate Screenshot Upload"
2. Browser will prompt for screen sharing permission
3. Grant or deny — both generate capturable events

### Testing Tab Switching

The page tracks:
- `visibilitychange` — when tab becomes hidden/visible
- `window.focus` / `window.blur` — when window gains/loses focus

Switch between tabs or minimize the window to generate these events.

### Integrating with OpenCluely

To test the full OpenCluely pipeline:

1. Load `test-proctor.html` in OpenCluely's browser window
2. Ensure capture.js is injected (check `main.js` for injection logic)
3. Perform test actions (type, switch tabs, etc.)
4. Verify OpenCluely's capture service receives and processes the events

### Troubleshooting

| Issue | Solution |
|-------|----------|
| No events in server console | Check that capture.js is injected and running |
| CORS errors | The mock server sets CORS headers; ensure you're not blocking localhost |
| capture.js not intercepting | Verify it's loaded before the page's own scripts (use `Page.addScriptToEvaluateOnNewDocument`) |
| Events not reaching OpenCluely | Check IPC channel between preload and main process |

### Next Steps

Once the mock test works:
1. **Add more event types** — mouse movements, copy/paste patterns, typing cadence
2. **Test with real proctoring flags** — modify the mock page to include `enable_proctoring: true` config
3. **Load test** — generate rapid events to ensure capture doesn't drop packets
4. **Compare with real HackerRank** — run against a live proctored test to see actual behavior

## Alternative: Browser Extension

For more realistic testing, consider packaging capture.js as a browser extension:

```javascript
// manifest.json
{
  "manifest_version": 3,
  "name": "Capture Test",
  "content_scripts": [{
    "matches": ["http://localhost:3000/*"],
    "js": ["capture.js"],
    "run_at": "document_start"
  }]
}
```

This ensures the tap is installed before any page scripts run.

## Summary

The mock proctor server gives you a **controlled, repeatable test environment** where you can verify:
- ✅ Keystroke capture works
- ✅ Tab switch detection works  
- ✅ Screenshot attempt detection works
- ✅ Events flow through capture.js to your backend

No external dependencies, no risk of triggering real anti-cheat systems, and full visibility into what's being captured.
