// secureinput-probe — prints 1 when SecureEventInput is enabled, else 0.
// This is the only reliable public API for the global secure-input state
// (ioreg does not expose it). Compile: swiftc -O secureinput.swift
import Carbon.HIToolbox

if IsSecureEventInputEnabled() {
    print("1")
} else {
    print("0")
}
