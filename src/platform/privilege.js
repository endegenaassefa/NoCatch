// ── Cross-platform process-privilege detection for root exam mode ──
//
// macOS/Linux: uid 0 (the legacy `process.getuid() === 0` check, unchanged).
// Windows: the token integrity level parsed from `whoami /groups` output.
//   S-1-16-12288 (High)   → elevated Administrator token
//   S-1-16-16384 (System) → SYSTEM
//   anything else         → normal user, root mode off
//
// The Windows check is evidence from the real process token, never an env
// var or launcher claim: an unelevated process cannot produce a High/System
// SID, and an elevated one cannot produce Medium.

const { spawnSync } = require("node:child_process");

// Ordered well-known Windows integrity-level SIDs (most privileged first).
const INTEGRITY_LEVELS = [
  [16384, "system"],
  [12288, "high"],
  [8448, "medium-plus"],
  [8192, "medium"],
  [4096, "low"],
  [0, "untrusted"],
];

function parseWindowsIntegrity(raw) {
  const text = String(raw || "");
  for (const [sid, label] of INTEGRITY_LEVELS) {
    // Match the complete SID. A prefix such as S-1-16-122880 must not be
    // mistaken for the High integrity SID S-1-16-12288.
    if (new RegExp(`\\bS-1-16-${sid}(?![\\d-])`).test(text)) return label;
  }
  return "unknown";
}

function detectWindowsPrivilege() {
  let integrity = "unknown";
  try {
    const res = spawnSync("whoami", ["/groups"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status === 0) integrity = parseWindowsIntegrity(res.stdout);
  } catch (_) {
    integrity = "unknown";
  }
  const isRoot = integrity === "high" || integrity === "system";
  return {
    platform: process.platform,
    isRoot,
    method: "whoami-integrity",
    integrity,
    detail: `win32 ${isRoot ? "elevated" : "unelevated"} (integrity ${integrity})`,
  };
}

function detectUnixPrivilege() {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    platform: process.platform,
    isRoot,
    method: "getuid",
    integrity: isRoot ? "root" : "user",
    detail: `${process.platform} ${isRoot ? "root" : "user"}`,
  };
}

let cached = null;
function detect() {
  if (!cached) {
    cached = process.platform === "win32" ? detectWindowsPrivilege() : detectUnixPrivilege();
  }
  return cached;
}

// A fixed machine-scoped root data directory. Elevated processes must not
// accept an inherited environment variable that redirects their Chromium
// profile or settings into an ordinary user's writable directory.
function rootDataDir() {
  return "C:\\ProgramData\\CluelyRoot";
}

module.exports = { detect, parseWindowsIntegrity, rootDataDir };
