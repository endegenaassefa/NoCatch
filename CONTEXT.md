# OpenCluely Context

Glossary for the OpenCluely repo: an AI interview copilot whose floating windows are invisible to screen capture and must never disturb the exam page the user is being proctored on.

## Language

**OpenCluely**:
The desktop app this repo builds — answers questions from typed chat, screenshots, or voice on floating overlay windows.

**Proctor page**:
The exam page in a browser that a proctoring service watches; here, the local test page served by the mock proctor.

**Mock proctor**:
The repo's own test harness (server + test page + event log) that stands in for a real proctoring service and records focus/visibility events so stealth can be verified.

**Proctor event**:
A record the proctor page emits when its state changes: `window_blur`, `window_focus`, or `visibilitychange` (visible/hidden).

**Heartbeat**:
A periodic keepalive row the proctor page sends on a timer. It carries the page's *current* state (`visibilityState`, `documentState`) but is not a transition event — a heartbeat that says `hidden` is not, by itself, a caught event.

**Caught**:
A proctor event fired while the user interacts with OpenCluely — the failure stealth exists to prevent. Heartbeats are excluded.

**Blur storm**:
A burst of caught events (`window_blur` / `visibilitychange:hidden`) clustered within a couple of minutes, tied to a specific user action in OpenCluely.

**Click-to-type leak**:
The residual leak where the user must click a focusable overlay window (chat, settings) to type into it; that click makes it macOS's key window and the proctor page fires `blur`.

**Stealth**:
The guarantees that OpenCluely leaves no detectable trace while the user works on the proctor page: windows invisible in screen capture, no focus theft from the proctor page, no clipboard writes, no capture of keystrokes meant for the exam, no audio output, and no outbound connections beyond the chosen LLM provider.

**Detection surface**:
The layers at which a proctoring service could observe OpenCluely: OS level (process identity, permissions, windows), browser level (focus/visibility/blur events on the proctor page), network level (connections, DNS/SNI), input level (keystrokes, paste/clipboard), and audio (mic usage, sounds).

**Overlay windows**:
OpenCluely's floating windows — the command bar, the AI response window, the chat, settings, and the first-run onboarding wizard.

**Provider**:
The LLM service that produces answers (Gemini or DeepSeek).
